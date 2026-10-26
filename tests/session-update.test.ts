import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const unix = (value: string) => process.platform === 'win32' ? value.replace(/\\/g, '/').replace(/^([a-z]):/i, (_, drive: string) => '/' + drive.toLowerCase()) : value;
const roots: string[] = [];
const oldImage = 'sha256:' + 'a'.repeat(64), newImage = 'sha256:' + 'b'.repeat(64);
const fakeDocker = String.raw`
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), mode = process.env.FAKE_CASE;
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
const oldImage = 'sha256:'+'a'.repeat(64), newImage = 'sha256:'+'b'.repeat(64);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args)+'\n');
const save = () => fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
const die = text => { console.error(text); process.exit(21); };
if(args[0] === 'compose') {
  const cmd = args.slice(5);
  if(cmd[0] === 'config') {
    if(!cmd.includes('--quiet')) console.log(JSON.stringify({services:{app:{image:'nihongo-web:local',volumes:[{type:'bind',source:path.join(process.env.FAKE_RUNTIME,'server-data'),target:'/app/data'}]}}}));
  } else if(cmd[0] === 'ps') console.log('fixture-container');
  else if(cmd[0] === 'stop') { if(cmd.includes('app'))state.app=false; if(cmd.includes('caddy'))state.caddy=false; save(); }
  else if(cmd[0] === 'up') {
    if(cmd.at(-1) === 'app') { state.app=true; state.image=state.local; }
    if(cmd.at(-1) === 'caddy') { if(state.image===newImage && !state.verified)die('Gateway opened before verification'); state.caddy=true; }
    save();
  } else if(cmd[0] === 'run') {} // Caddy config validation
  else if(cmd[0] === 'exec') {
    if(cmd.includes('scripts/check-release-auth.mjs')) {
      if(!state.app || state.caddy || state.audits!==2)die('Invalid authentication check order');
      if(mode==='auth_failure')die('Fixture auth failure');
      state.verified=true; save(); console.log('AUTH_VERIFIED v1.4.1');
    } else console.log('1.4.1');
  } else die('Unknown compose command');
} else if(args[0] === 'inspect') {
  if(args[1] === '--format')console.log(state.image);
  else console.log(JSON.stringify([{Mounts:[{Type:'bind',Destination:'/app/data',Source:path.join(process.env.FAKE_RUNTIME,'server-data')}]}]));
} else if(args[0] === 'build') {}
else if(args[0] === 'image')console.log(newImage);
else if(args[0] === 'tag') { if(args[2]==='nihongo-web:local')state.local=args[1]; save(); }
else if(args[0] === 'run') {
  if(state.app || state.caddy)die('Audit while database writers or gateway running');
  if(!args.includes('--read-only') || !args.includes('--tmpfs') || !args.some(v=>v.endsWith('/server-data:/app/data:ro')))die('Unsafe audit mounts');
  state.audits++; save();
  if(mode==='audit_failure')die('SQLITE_CANTOPEN fixture');
  if(state.audits===2 && mode==='changed_data') {
    fs.writeFileSync(path.join(process.env.FAKE_RUNTIME,'server-data/nihongo.sqlite'),'newer-learning-progress');
    console.log('changed');
  } else console.log('identical-digest');
} else die('Unknown Docker command');
`;
function fixture(mode = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'nihongo-session-update-test-')); roots.push(root);
  const source = join(root, 'source'), runtime = join(root, 'runtime'), bin = join(root, 'bin');
  for (const dir of [join(source, 'deploy'), join(runtime, 'deploy'), join(runtime, 'server-data'), bin]) mkdirSync(dir, { recursive: true });
  for (const file of ['update-session-release.sh', 'migrate-session-auth.mjs']) copyFileSync(resolve('deploy', file), join(source, 'deploy', file));
  writeFileSync(join(source, 'package.json'), '{"version":"1.4.1"}');
  copyFileSync('compose.yaml', join(runtime, 'compose.yaml'));
  copyFileSync('deploy/Caddyfile', join(runtime, 'deploy/Caddyfile'));
  writeFileSync(join(runtime, '.env'), 'APP_AUTH_USER=fixture\nAPP_AUTH_HASH=fixture-secret-never-log\n');
  writeFileSync(join(runtime, 'server-data/nihongo.sqlite'), 'original-learning-progress');
  const stateFile = join(root, 'state.json'), logFile = join(root, 'calls.jsonl');
  writeFileSync(stateFile, JSON.stringify({ image: oldImage, local: oldImage, app: true, caddy: true, audits: 0 }));
  writeFileSync(logFile, ''); writeFileSync(join(root, 'docker.cjs'), fakeDocker);
  for (const [file, content] of Object.entries({
    id: '#!/usr/bin/env bash\nprintf "0\\n"\n',
    flock: '#!/usr/bin/env bash\nexit 0\n',
    docker: '#!/usr/bin/env bash\nMSYS2_ARG_CONV_EXCL="*" exec node "$FAKE_DOCKER_JS" "$@"\n',
  })) { writeFileSync(join(bin, file), content); chmodSync(join(bin, file), 0o755); }
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', 'export PATH="$1"; shift; exec bash --noprofile --norc "$@"', 'fixture', `${unix(bin)}:${unix(dirname(process.execPath))}:/usr/bin:/bin`, unix(join(source, 'deploy/update-session-release.sh')), unix(runtime)], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, FAKE_CASE: mode, FAKE_RUNTIME: runtime, FAKE_STATE: stateFile, FAKE_LOG: logFile, FAKE_DOCKER_JS: join(root, 'docker.cjs') },
  });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  expect(output).not.toContain('fixture-secret-never-log');
  return { root, runtime, result, output, state: JSON.parse(readFileSync(stateFile, 'utf8')) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('session release rollout', () => {
  it('audits twice with writers stopped, verifies authentication, then opens the gateway', () => {
    const value = fixture();
    expect(value.result.status, value.output).toBe(0);
    expect(value.output).toContain('UPDATE_OK v1.4.1');
    expect(value.state).toMatchObject({ app: true, caddy: true, image: newImage, audits: 2, verified: true });
    expect(readdirSync(value.root).filter(name => name.startsWith('nihongo-session-backup-'))).toHaveLength(1);
    expect(readFileSync(join(value.runtime, 'server-data/nihongo.sqlite'), 'utf8')).toBe('original-learning-progress');
  }, 40000);
  it.each(['audit_failure', 'changed_data', 'auth_failure'])('restores old code after %s without restoring an old database', mode => {
    const value = fixture(mode);
    expect(value.result.status, value.output).not.toBe(0);
    expect(value.output).not.toContain('UPDATE_OK');
    expect(value.output).toContain('current learning data preserved');
    expect(value.state).toMatchObject({ app: true, caddy: true, image: oldImage });
    expect(readFileSync(join(value.runtime, 'server-data/nihongo.sqlite'), 'utf8')).toBe(mode === 'changed_data' ? 'newer-learning-progress' : 'original-learning-progress');
  }, 40000);
});
