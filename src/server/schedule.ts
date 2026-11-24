import type { FastifyInstance } from 'fastify';
import { readFile, rename, open, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { scheduleStateSchema, type ScheduleDocument } from '../shared/schedule';
import { ApiError } from './schemas';

// Independent of learning SQLite. A stale browser cannot replace a newer plan.
export function registerSchedule(app: FastifyInstance, dataDir: string) {
  const filename = path.join(dataDir, 'weekly-schedule.json');
  let pending: Promise<unknown> = Promise.resolve();
  async function read(): Promise<ScheduleDocument> {
    try {
      const value = JSON.parse(await readFile(filename, 'utf8'));
      const state = scheduleStateSchema.parse(value.state);
      const revision = createHash('sha256').update(JSON.stringify(state)).digest('hex');
      if (revision !== value.revision) throw new Error('Schedule checksum mismatch');
      return { revision, state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: null, state: null };
      throw error;
    }
  }
  app.get('/api/schedule', async () => { await pending; return read(); });
  app.put('/api/schedule', async request => {
    const input = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/).nullable(), state: scheduleStateSchema }).strict().parse(request.body);
    const operation = pending.then(async () => {
      const current = await read();
      const revision = createHash('sha256').update(JSON.stringify(input.state)).digest('hex');
      if (current.revision === revision) return current;
      if (current.revision !== input.revision) throw new ApiError(409, 'SCHEDULE_CONFLICT', '其他设备已更新日程，请先导出本机改动，再刷新核对。');
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ revision, state: input.state })); await file.sync(); } finally { await file.close(); }
        await rename(temporary, filename);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return { revision, state: input.state } satisfies ScheduleDocument;
    });
    pending = operation.catch(() => {});
    return operation;
  });
  app.addHook('onClose', async () => { await pending; });
}
