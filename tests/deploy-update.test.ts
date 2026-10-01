import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// The real updater runs in Git Bash with isolated fake Docker/id/flock commands.
// No real Docker daemon, credentials, application data or network is accessed.
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const script = resolve('deploy/update-release.sh');
const oldImage = 'sha256:' + 'a'.repeat(64), newImage = 'sha256:' + 'b'.repeat(64);
const directories: string[] = [];
const unix = (value: string) => process.platform === 'win32' ? value.replace(/\\/g, '/').replace(/^([a-z]):/i, (_, drive: string) => '/' + drive.toLowerCase()) : value;
const fakeDocker = String.raw`
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), mode = process.env.FAKE_CASE;
const stateFile = process.env.FAKE_STATE, state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\n');
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const die = () => { save(); process.exit(21); };
const oldImage = 'sha256:' + 'a'.repeat(64), newImage = 'sha256:' + 'b'.repeat(64);
if (args[0] === 'compose') {
  const command = args.slice(5);
  if (command[0] === 'config') {
    if (command.includes('--quiet')) process.exit(0);
    const data = mode === 'desired_mount' ? path.join(process.env.FAKE_RUNTIME,'wrong-data') : path.join(process.env.FAKE_RUNTIME, 'server-data');
    console.log(JSON.stringify({services:{app:{image:mode === 'desired_image'?'other-image:local':'nihongo-web:local',volumes:[{type:'bind',source:data,target:'/app/data'}],environment:{FAKE_SECRET:'fixture-never-log-me'}},caddy:{image:'caddy:test'}}}));
  } else if (command[0] === 'ps') console.log(state.running ? 'fixture-container-id' : '');
  else if (command[0] === 'exec') console.log(state.image === newImage ? (mode === 'new_version' ? '0.0.0' : '1.1.2') : state.oldVersion);
  else if (command[0] === 'stop') { state.running = false; save(); if (mode === 'stop_failure') die(); }
  else if (command[0] === 'up') {
    state.image = state.local; state.running = true; save();
    if (state.image === newImage && ['up_failure','rollback_failure'].includes(mode)) die();
    if (state.image === oldImage && mode === 'rollback_failure') die();
  } else die();
} else if (args[0] === 'inspect') {
  if (args[1] === '--format') {
    if (args[2] === '{{.Config.Image}}') console.log(mode === 'actual_image' ? 'other-image:local' : 'nihongo-web:local');
    else if (args[2] === '{{.Image}}') console.log(mode === 'new_image' && state.image === newImage ? 'sha256:'+'c'.repeat(64) : state.image);
    else if (args[2] === '{{.State.Health.Status}}') console.log(mode === 'new_health' && state.image === newImage ? 'unhealthy' : 'healthy');
    else die();
  } else console.log(JSON.stringify([{Mounts:[{Type:'bind',Destination:'/app/data',Source:path.join(process.env.FAKE_RUNTIME,mode === 'actual_mount'?'wrong-data':'server-data')}],Config:{Env:['FAKE_SECRET=fixture-never-log-me']}}]));
} else if (args[0] === 'build') { if (mode === 'build_failure') die(); state.built = true; save(); }
else if (args[0] === 'image' && args[1] === 'inspect') { if (!state.built) die(); console.log(newImage); }
else if (args[0] === 'run') console.log(mode === 'built_version' ? '0.0.0' : '1.1.2');
else if (args[0] === 'tag') { if (args[2] === 'nihongo-web:local') state.local = args[1]; save(); }
else die();
`;

function fixture(mode = 'success', oldVersion = '1.1.1') {
  const root = mkdtempSync(join(tmpdir(), 'nihongo-updater-test-')); directories.push(root);
  const source = join(root, 'source'), runtime = join(root, 'runtime'), bin = join(root, 'bin');
  for (const dir of [join(source, 'deploy'), join(runtime, 'deploy'), join(runtime, 'server-data'), bin]) mkdirSync(dir, { recursive: true });
  copyFileSync(script, join(source, 'deploy/update-release.sh'));
  writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '1.1.2' }));
  writeFileSync(join(source, 'deploy/Caddyfile'), 'SOURCE MUST NEVER REPLACE RUNTIME CONFIG');
  const preserved = { '.env': 'FAKE_SECRET=fixture-never-log-me\n', 'compose.yaml': 'services: {app: {image: "nihongo-web:local"}, caddy: {image: "caddy:test"}}\n', 'deploy/Caddyfile': 'fixture-IP-HTTPS-with-existing-login\n', 'server-data/nihongo.sqlite': 'fake-database-for-update-tests\n', 'server-data/nihongo.sqlite-wal': 'fake-WAL-for-consistent-backup-tests\n' };
  for (const [file, content] of Object.entries(preserved)) writeFileSync(join(runtime, file), content);
  const stateFile = join(root, 'state.json'), logFile = join(root, 'docker.jsonl');
  writeFileSync(stateFile, JSON.stringify({ image: oldImage, local: oldImage, running: true, oldVersion, built: false }));
  writeFileSync(logFile, ''); writeFileSync(join(root, 'docker.cjs'), fakeDocker);
  const commands = {
    id: '#!/usr/bin/env bash\nprintf "0\\n"\n',
    flock: '#!/usr/bin/env bash\n[[ "$FAKE_CASE" != lock ]]\n',
    docker: '#!/usr/bin/env bash\nMSYS2_ARG_CONV_EXCL="*" exec node "$FAKE_DOCKER_JS" "$@"\n',
    tar: '#!/usr/bin/env bash\nif [[ "$FAKE_CASE" == tar_failure && "$1" == -czf ]] || [[ "$FAKE_CASE" == tar_verify && "$1" == -tzf ]]; then exit 24; fi\nexec /usr/bin/tar "$@"\n',
  };
  for (const [file, content] of Object.entries(commands)) { const destination = join(bin, file); writeFileSync(destination, content); chmodSync(destination, 0o755); }
  const commandPath = `${unix(bin)}:${unix(dirname(process.execPath))}:/usr/bin:/bin`;
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', 'export PATH="$1"; shift; exec bash --noprofile --norc "$@"', 'fixture', commandPath, unix(join(source, 'deploy/update-release.sh')), unix(runtime)], {
    cwd: root, encoding: 'utf8', timeout: 25000, windowsHide: true,
    env: { ...process.env, FAKE_CASE: mode, FAKE_RUNTIME: runtime, FAKE_STATE: stateFile, FAKE_LOG: logFile, FAKE_DOCKER_JS: join(root, 'docker.cjs') },
  });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  expect(output).not.toContain('fixture-never-log-me');
  for (const [file, content] of Object.entries(preserved)) expect(readFileSync(join(runtime, file), 'utf8')).toBe(content);
  const calls = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
  return { root, runtime, source, result, output, calls, state: JSON.parse(readFileSync(stateFile, 'utf8')), backups: readdirSync(root).filter(file => file.startsWith('nihongo-backup-v112-')) };
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir(), 'nihongo-updater-test-'))) throw new Error('Unexpected updater test directory');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('bounded server release updater', () => {
  it('has valid shell syntax', () => {
    expect(existsSync(bash)).toBe(true);
    const check = spawnSync(bash, ['-n', unix(script)], { encoding: 'utf8', windowsHide: true });
    expect(check.status, check.stderr).toBe(0);
  });
  it('builds before stopping, backs up existing data/config and verifies the actual new version without recreating Caddy', () => {
    const value = fixture(); expect(value.result.status, value.output).toBe(0); expect(value.output).toContain('UPDATE_OK v1.1.2');
    expect(value.state).toMatchObject({ image: newImage, local: newImage, running: true }); expect(value.backups).toHaveLength(1);
    const backup = join(value.root, value.backups[0]!); expect(readFileSync(join(backup, 'old-image.txt'), 'utf8').trim()).toBe(oldImage);
    const listed = spawnSync(bash, ['-c', 'tar -tzf "$1"', 'fixture', unix(join(backup, 'data-and-config.tar.gz'))], { encoding: 'utf8', windowsHide: true });
    expect(listed.status, listed.stderr).toBe(0);
    for (const file of ['server-data/nihongo.sqlite', 'server-data/nihongo.sqlite-wal', '.env', 'compose.yaml', 'deploy/Caddyfile']) expect(listed.stdout).toContain(file);
    const buildIndex = value.calls.findIndex(call => call[0] === 'build');
    const stopIndex = value.calls.findIndex(call => call[0] === 'compose' && call[5] === 'stop'); expect(buildIndex).toBeLessThan(stopIndex);
    const ups = value.calls.filter(call => call[0] === 'compose' && call[5] === 'up'); expect(ups).toHaveLength(1);
    expect(ups[0]).toEqual(['compose', '-p', 'nihongo-web', '-f', 'compose.yaml', 'up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--wait', '--wait-timeout', '180', 'app']);
    expect(value.calls.some(call => call.includes('down') || call.includes('prune') || (call[0] === 'compose' && call.at(-1) === 'caddy'))).toBe(false);
  }, 30000);
  it.each(['build_failure', 'built_version', 'lock', 'desired_image', 'desired_mount', 'actual_image', 'actual_mount'])('leaves the app running without interruption on %s', mode => {
    const value = fixture(mode); expect(value.result.status, value.output).not.toBe(0); expect(value.output).not.toContain('UPDATE_OK');
    expect(value.state).toMatchObject({ image: oldImage, local: oldImage, running: true });
    expect(value.calls.some(call => call[0] === 'compose' && ['stop', 'up'].includes(call[5]!))).toBe(false); expect(value.backups).toHaveLength(0);
    const messages: Record<string, string> = { built_version: 'built image version', lock: 'Another update is already running', desired_image: 'Unexpected runtime image', desired_mount: 'Unexpected runtime image', actual_image: 'running app uses an unexpected image', actual_mount: 'running app uses another data directory' };
    if (mode === 'build_failure') expect(value.calls.some(call => call[0] === 'build')).toBe(true);
    else expect(value.output).toContain(messages[mode]);
  }, 30000);
  it.each(['stop_failure', 'tar_failure', 'tar_verify', 'up_failure', 'new_health', 'new_version', 'new_image'])('restores the previous image and verifies recovery on %s', mode => {
    const value = fixture(mode); expect(value.result.status, value.output).not.toBe(0); expect(value.output).toContain('ROLLBACK_OK v1.1.1'); expect(value.output).not.toContain('UPDATE_OK');
    expect(value.state).toMatchObject({ image: oldImage, local: oldImage, running: true });
    expect(value.backups).toHaveLength(1);
    const rollback = value.calls.findIndex(call => call[0] === 'tag' && call[1] === oldImage && call[2] === 'nihongo-web:local'); expect(rollback).toBeGreaterThan(0);
    expect(value.calls.slice(rollback).some(call => call[0] === 'compose' && call[5] === 'up' && call.includes('--wait'))).toBe(true);
  }, 30000);
  it('reports an unsuccessful rollback honestly and retains recovery metadata', () => {
    const value = fixture('rollback_failure'); expect(value.result.status, value.output).not.toBe(0); expect(value.output).toContain('ROLLBACK_FAILED'); expect(value.output).not.toContain('ROLLBACK_OK'); expect(value.output).not.toContain('UPDATE_OK');
    expect(readFileSync(join(value.root, value.backups[0]!, 'old-image.txt'), 'utf8').trim()).toBe(oldImage);
  }, 30000);
  it.each(['1.0.9', '1.2.0', '2.0.0'])('rejects an incompatible existing version %s before building or stopping', version => {
    const value = fixture('success', version); expect(value.result.status, value.output).not.toBe(0);
    expect(value.output).toContain('Only installed versions 1.1.0–1.1.2');
    expect(value.calls.some(call => call[0] === 'build' || (call[0] === 'compose' && call[5] === 'stop'))).toBe(false);
  }, 30000);
});
