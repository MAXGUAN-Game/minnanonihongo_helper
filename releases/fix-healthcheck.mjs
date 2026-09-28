// Repair the web probe without rebuilding images or changing credentials/data.
// Compatible with the Ubuntu host's Node 18; no npm dependencies required.
import { copyFile, lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const oldCheck = "fetch('http://127.0.0.1:4317/api/health',{headers:{host:new URL(process.env.APP_PUBLIC_ORIGIN).host,origin:process.env.APP_PUBLIC_ORIGIN,'x-nihongo-proxy':process.env.APP_PROXY_TOKEN},signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))";
export const newCheck = "require('node:http').get('http://127.0.0.1:4317/api/health',{headers:{host:new URL(process.env.APP_PUBLIC_ORIGIN).host,origin:process.env.APP_PUBLIC_ORIGIN,'x-nihongo-proxy':process.env.APP_PROXY_TOKEN},signal:AbortSignal.timeout(4000)},r=>{r.resume();if(r.statusCode!==200)console.error('Health HTTP '+r.statusCode);process.exit(r.statusCode===200?0:1)}).on('error',e=>{console.error(e.code||'HEALTHCHECK_ERROR');process.exit(1)})";

export function patchCompose(text) {
  const oldCount = text.split(oldCheck).length - 1;
  const newCount = text.split(newCheck).length - 1;
  if (oldCount === 0 && newCount === 1) return text;
  if (oldCount !== 1 || newCount !== 0) throw new Error('Unknown healthcheck configuration; no automatic replacement.');
  return text.replace(oldCheck, newCheck);
}

async function main() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Run on the Ubuntu server: sudo node /tmp/fix-healthcheck.mjs');
  const root = await realpath(process.argv[2] || '/opt/nihongo');
  const docker = (args, quiet = false) => {
    const result = spawnSync('/usr/bin/docker', args, { cwd: root, stdio: quiet ? 'ignore' : 'inherit', timeout: 180000 });
    if (result.error || result.status !== 0) throw new Error(`Docker command failed (${result.error?.code || result.status}). Review the message above; backups are preserved.`);
  };
  // Do not interrupt any build until the previously built application image exists.
  docker(['image', 'inspect', 'nihongo-web:local'], true);
  docker(['compose', 'config', '--quiet']);
  const changes = [];
  for (const name of ['compose.yaml', 'compose.shared.yaml']) {
    const file = path.join(root, name);
    let info;
    try { info = await lstat(file); }
    catch (error) { if (name === 'compose.shared.yaml' && error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${name}`);
    const before = await readFile(file, 'utf8');
    const after = patchCompose(before);
    if (after !== before) changes.push({ name, file, before, after, mode: info.mode & 0o777 });
  }
  // The old detached Compose command may still be waiting on the broken probe.
  const state = spawnSync('systemctl', ['is-active', 'nihongo-deploy.service'], { encoding: 'utf8' });
  if (state.error || ![0, 3, 4].includes(state.status)) throw new Error('Could not check the previous deployment task; no configuration changed.');
  if (['active', 'activating', 'deactivating', 'reloading'].includes(state.stdout.trim())) {
    console.log('Stopping the previous deployment command before applying the repair.');
    const stop = spawnSync('systemctl', ['stop', 'nihongo-deploy.service'], { stdio: 'inherit', timeout: 180000 });
    if (stop.error || stop.status !== 0) throw new Error('Could not stop the previous deployment command; no configuration changed.');
  }
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + process.pid;
  for (const change of changes) {
    const backup = change.file + '.before-healthcheck-' + stamp;
    await copyFile(change.file, backup);
    const temporary = change.file + '.pending-healthcheck-' + stamp;
    await writeFile(temporary, change.after, { mode: change.mode, flag: 'wx' });
    await rename(temporary, change.file);
    console.log(`Updated ${change.name}; backup: ${path.basename(backup)}`);
  }
  if (!changes.length) console.log('Healthcheck is already repaired.');
  docker(['compose', 'config', '--quiet']);
  console.log('Starting existing images. This can take up to two minutes for health checks.');
  docker(['compose', 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120']);
  docker(['compose', 'ps', '-a']);
  console.log('Containers are running. Next: open https://jp.nbblearnjp.xyz and verify HTTPS/login.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
