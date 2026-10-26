import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Store } from './store';

export function withoutRecordingLinks<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item) => key === 'recordingId' ? undefined : item));
}

/** Only application-owned audio names in known direct child directories are removed. */
export function retireRecordingArchives(store: Store, dataDir: string) {
  store.db.transaction(() => {
    for (const table of ['attempts', 'ai_attempts', 'assessments', 'sessions'] as const) {
      for (const record of store.all<{ id: string }>(table)) store.save(table, record.id, withoutRecordingLinks(record));
    }
    store.db.exec('DELETE FROM recording_files; DELETE FROM recordings;');
  })();
  const root = path.resolve(dataDir);
  if (lstatSync(root).isSymbolicLink()) throw new Error('Audio cleanup requires a real data directory.');
  for (const parts of [['recordings'], ['speech', 'tmp']]) {
    let folder = root;
    let valid = true;
    for (const part of parts) {
      folder = path.join(folder, part);
      if (!existsSync(folder)) { valid = false; break; }
      const info = lstatSync(folder);
      if (info.isSymbolicLink() || !info.isDirectory()) { valid = false; break; }
    }
    if (!valid) continue;
    for (const name of readdirSync(folder)) {
      if (!(parts[0] === 'recordings' ? /^[0-9a-f-]{36}\.wav(?:\.pending-[0-9a-f-]{36})?$/i : /^utterance-.*\.(wav|webm|mp3|m4a)$/i).test(name)) continue;
      const target = path.resolve(folder, name);
      if (path.dirname(target) !== folder) continue;
      const info = lstatSync(target);
      if (info.isFile() && !info.isSymbolicLink()) unlinkSync(target);
    }
  }
}
