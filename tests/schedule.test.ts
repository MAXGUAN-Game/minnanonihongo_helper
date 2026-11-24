import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/server/app';
import { deploymentConfig } from '../src/server/deployment';
import { authEnvironment } from './auth-fixture';

const state = { version: 2, activeWeek: '2026-11-16', events: [{ id: 'stable-1', day: 0, start: 520, end: 540, category: 'japanese', title: '复习', notes: '保留备注' }], view: { filter: 'all', showRoutines: false, foldRoutines: false }, legacyWeeks: {} };
describe('server schedule storage', () => {
  it('requires application authentication before reading or saving the plan', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'nihongo-schedule-auth-'));
    const origin = 'https://study.example.com', token = 'proxy-token-test-only-'.repeat(3);
    const app = buildApp({ dataDir: temporary, deployment: deploymentConfig({ DEPLOYMENT: 'web', APP_PUBLIC_ORIGIN: origin, APP_PROXY_TOKEN: token, ...authEnvironment }) });
    const headers = { host: 'study.example.com', origin, 'x-nihongo-proxy': token };
    try {
      expect((await app.inject({ url: '/api/schedule', headers })).statusCode).toBe(401);
      expect((await app.inject({ method: 'PUT', url: '/api/schedule', headers, payload: { revision: null, state } })).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: 'learner', password: 'fixture-password-only' } });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      expect((await app.inject({ method: 'PUT', url: '/api/schedule', headers: { ...headers, cookie }, payload: { revision: null, state } })).statusCode).toBe(200);
    } finally { await app.close(); await rm(temporary, { recursive: true, force: true }); }
  });
  it('persists stable IDs and legacy data across restarts, rejecting stale and concurrent saves', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'nihongo-schedule-api-'));
    let app = buildApp({ dataDir: temporary });
    const headers = { host: '127.0.0.1' };
    try {
      expect((await app.inject({ url: '/api/schedule', headers })).json()).toEqual({ revision: null, state: null });
      const saved = (await app.inject({ method: 'PUT', url: '/api/schedule', headers, payload: { revision: null, state } })).json();
      expect(saved.state).toEqual(state); expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
      await app.close(); app = buildApp({ dataDir: temporary });
      expect((await app.inject({ url: '/api/schedule', headers })).json()).toEqual(saved);
      const changed = { ...state, events: [{ ...state.events[0], notes: '新设备更新' }] };
      const stale = await app.inject({ method: 'PUT', url: '/api/schedule', headers, payload: { revision: null, state: changed } });
      expect(stale.statusCode).toBe(409);
      const responses = await Promise.all(['设备一', '设备二'].map(notes => app.inject({ method: 'PUT', url: '/api/schedule', headers, payload: { revision: saved.revision, state: { ...changed, events: [{ ...changed.events[0], notes }] } } })));
      expect(responses.map(value => value.statusCode).sort()).toEqual([200, 409]);
      const latest = (await app.inject({ url: '/api/schedule', headers })).json();
      expect(latest.state.events[0].id).toBe('stable-1');
      expect(JSON.parse(await readFile(path.join(temporary, 'weekly-schedule.json'), 'utf8'))).toEqual(latest);
      const retry = await app.inject({ method: 'PUT', url: '/api/schedule', headers, payload: { revision: saved.revision, state: latest.state } });
      expect(retry.statusCode).toBe(200);
    } finally { await app.close(); await rm(temporary, { recursive: true, force: true }); }
  });
  it('rejects invalid events and never resets a damaged existing schedule', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'nihongo-schedule-invalid-'));
    const app = buildApp({ dataDir: temporary });
    try {
      const response = await app.inject({ method: 'PUT', url: '/api/schedule', headers: { host: '127.0.0.1' }, payload: { revision: null, state: { ...state, events: [{ ...state.events[0], end: 100 }] } } });
      expect(response.statusCode).toBe(400);
      await writeFile(path.join(temporary, 'weekly-schedule.json'), 'damaged-test-fixture');
      expect((await app.inject({ url: '/api/schedule', headers: { host: '127.0.0.1' } })).statusCode).toBe(500);
      expect(await readFile(path.join(temporary, 'weekly-schedule.json'), 'utf8')).toBe('damaged-test-fixture');
    } finally { await app.close(); await rm(temporary, { recursive: true, force: true }); }
  });
});
