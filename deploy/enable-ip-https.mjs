// Run only on the existing independent Ubuntu deployment. Node 18+, no npm install.
// IP HTTPS does not exempt a mainland server from applicable filing requirements.
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IP_ADDRESS = '8.133.242.232';
const ROOT = '/opt/nihongo';
const BACKUPS = '.ip-https-backups';
const originalCaddy = `{
\tadmin off
}

{$APP_DOMAIN} {
\tencode zstd gzip

\theader {
\t\tX-Content-Type-Options nosniff
\t\tReferrer-Policy same-origin
\t\tX-Frame-Options DENY
\t\tPermissions-Policy "microphone=(self), camera=(), geolocation=()"
\t\t-Server
\t}

\t# Explicit ordering prevents any route (including /api/health) bypassing login.
\troute {
\t\tbasic_auth {
\t\t\t{$APP_AUTH_USER} {$APP_AUTH_HASH}
\t\t}
\t\treverse_proxy app:4317 {
\t\t\theader_up -Authorization
\t\t\theader_up X-Nihongo-Proxy {$APP_PROXY_TOKEN}
\t\t\ttransport http {
\t\t\t\tdial_timeout 10s
\t\t\t\tresponse_header_timeout 150s
\t\t\t}
\t\t}
\t}
}
`;
const ipCaddy = originalCaddy
  .replace('\tadmin off\n', '\tadmin off\n\t# Managed by deploy/enable-ip-https.mjs: IP clients may omit SNI.\n\tdefault_sni {$APP_DOMAIN}\n')
  .replace('{$APP_DOMAIN} {\n', `{$APP_DOMAIN} {
\t# Managed by deploy/enable-ip-https.mjs: publicly trusted, short-lived IP certificate.
\ttls {
\t\tissuer acme {
\t\t\tdir https://acme-v02.api.letsencrypt.org/directory
\t\t\tprofile shortlived
\t\t\tdisable_tlsalpn_challenge
\t\t}
\t}

`);

export function patchEnv(text, ip = IP_ADDRESS) {
  if (typeof text !== 'string' || isIP(ip) !== 4) throw new Error('Invalid environment or IPv4 address.');
  const definitions = text.match(/^[\t ]*(?:export[\t ]+)?APP_DOMAIN[\t ]*=/gm) || [];
  const match = text.match(/^APP_DOMAIN=([a-z0-9.-]+)(?=\r?$)/m);
  if (definitions.length !== 1 || !match || !match[1].includes('.') || match[1].includes('..')) throw new Error('Unknown APP_DOMAIN format; no automatic replacement.');
  return text.replace(/^APP_DOMAIN=([a-z0-9.-]+)(?=\r?$)/m, `APP_DOMAIN=${ip}`);
}

export function patchCaddy(text) {
  if (typeof text !== 'string') throw new Error('Invalid Caddyfile.');
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized === ipCaddy) return text;
  if (normalized !== originalCaddy) throw new Error('Unknown Caddyfile; no automatic replacement.');
  return ipCaddy.replace(/\n/g, text.includes('\r\n') ? '\r\n' : '\n');
}

// No credentials, TLS bypass, custom CA, or IP-valued SNI. Node checks the IP SAN
// and normal public trust chain before this HTTPS response can count as success.
export function probeHttps(url, { timeoutMs = 5000, get = httpsGet } = {}) {
  let destination;
  try { destination = new URL(url); } catch { return Promise.resolve({ ok: false, reason: 'INVALID_URL' }); }
  if (destination.protocol !== 'https:' || isIP(destination.hostname) !== 4 || destination.username || destination.password) return Promise.resolve({ ok: false, reason: 'INVALID_URL' });
  return new Promise(resolveProbe => {
    let settled = false;
    let request;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe(result);
    };
    try {
      request = get(destination, { rejectUnauthorized: true }, response => {
        response.resume();
        const status = response.statusCode || 0;
        const challenge = response.headers['www-authenticate'];
        const ok = response.socket.authorized === true && status === 401 && typeof challenge === 'string' && /^Basic(?:\s|$)/i.test(challenge);
        finish({ ok, reason: ok ? 'HTTPS_BASIC_AUTH_VERIFIED' : status !== 401 ? `HTTP_${status}` : 'LOGIN_OR_TLS_NOT_VERIFIED', status });
      });
      request.on('error', error => finish({ ok: false, reason: /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'HTTPS_ERROR' }));
      timer = setTimeout(() => { finish({ ok: false, reason: 'TIMEOUT' }); request.destroy(); }, timeoutMs);
      if (settled) clearTimeout(timer);
    } catch { finish({ ok: false, reason: 'HTTPS_ERROR' }); }
  });
}

async function regularFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file) throw new Error('Expected a regular configuration file without symbolic links.');
  const bytes = await readFile(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Configuration is not valid UTF-8; no automatic replacement.');
  return { text, mode: info.mode & 0o777 };
}

async function privateDirectory(directory) {
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Expected a private, regular backup directory.');
  await chmod(directory, 0o700);
}

async function atomicWrite(file, text, mode) {
  const temporary = file + `.pending-ip-https-${process.pid}`;
  await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode });
  await rename(temporary, file);
  await chmod(file, mode);
}

function docker(args, label, visible = false) {
  const result = spawnSync('/usr/bin/docker', args, {
    cwd: ROOT,
    // Explicit Compose paths and a clean environment prevent terminal exports
    // from overriding the existing authentication credentials in the env file.
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8' },
    stdio: visible ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`${label} failed (${result.error?.code || result.status}).`);
  return result;
}

function compose(envFile = path.join(ROOT, '.env')) {
  return ['compose', '--project-directory', ROOT, '--env-file', envFile, '-f', path.join(ROOT, 'compose.yaml')];
}

function validate(envFile, caddyFile) {
  docker([...compose(envFile), 'config', '--quiet'], 'Compose validation');
  // Adapt only: no listener, ACME request, certificate download, or image pull.
  // Discard adapted JSON because it contains the expanded password hash/token.
  docker([...compose(envFile), 'run', '--rm', '--no-deps', '--pull', 'never', '-T', '--entrypoint', 'caddy', '-v', `${caddyFile}:/etc/caddy/Caddyfile:ro`, 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], 'Offline Caddy validation');
}

function start() {
  docker([...compose(), 'up', '-d', '--no-build', '--pull', 'never', '--force-recreate', '--wait', '--wait-timeout', '120', 'app', 'caddy'], 'Container startup', true);
}

async function restore(backup, caddyMode) {
  const env = await regularFile(path.join(backup, '.env'));
  const caddy = await regularFile(path.join(backup, 'Caddyfile'));
  patchEnv(env.text);
  patchCaddy(caddy.text);
  validate(path.join(backup, '.env'), path.join(backup, 'Caddyfile'));
  await atomicWrite(path.join(ROOT, '.env'), env.text, 0o600);
  await atomicWrite(path.join(ROOT, 'deploy/Caddyfile'), caddy.text, caddyMode);
  start();
}

async function waitForHttps() {
  const deadline = Date.now() + 90000;
  let last = { ok: false, reason: 'NOT_CHECKED' };
  while (Date.now() < deadline) {
    last = await probeHttps(`https://${IP_ADDRESS}/`, { timeoutMs: Math.min(5000, deadline - Date.now()) });
    if (last.ok) return;
    await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, Math.min(3000, deadline - Date.now()))));
  }
  throw new Error(`Public HTTPS verification failed (${last.reason}).`);
}

async function main() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Run on the existing Ubuntu server: sudo node /tmp/enable-ip-https.mjs');
  const args = process.argv.slice(2);
  const rollback = args.length === 2 && args[0] === '--rollback' && /^\d{17}-\d+$/.test(args[1]);
  if (args.length && !rollback) throw new Error('Usage: sudo node /tmp/enable-ip-https.mjs [--rollback BACKUP_ID]');
  if (await realpath(ROOT) !== ROOT) throw new Error('Expected the independent deployment at /opt/nihongo.');
  const envFile = path.join(ROOT, '.env');
  const caddyFile = path.join(ROOT, 'deploy/Caddyfile');
  const originalEnv = await regularFile(envFile);
  const original = await regularFile(caddyFile);
  const backupRoot = path.join(ROOT, BACKUPS);
  await privateDirectory(backupRoot);
  docker(['image', 'inspect', 'nihongo-web:local', 'caddy:2.11.4-alpine'], 'Existing image check');
  const logsCommand = 'sudo docker compose --project-directory /opt/nihongo -f /opt/nihongo/compose.yaml logs --tail=80 caddy';
  if (rollback) {
    const backup = path.join(backupRoot, args[1]);
    if (await realpath(backup) !== backup) throw new Error('Unexpected backup location.');
    await restore(backup, original.mode);
    console.log('Original configuration restored and containers restarted. Verify the previous website address separately.');
    return;
  }
  const nextEnv = patchEnv(originalEnv.text);
  const nextCaddy = patchCaddy(original.text);
  docker([...compose(), 'config', '--quiet'], 'Existing Compose validation');
  const id = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + process.pid;
  const backup = path.join(backupRoot, id);
  await privateDirectory(backup);
  for (const [name, text] of [['.env', originalEnv.text], ['Caddyfile', original.text], ['proposed.env', nextEnv], ['proposed.Caddyfile', nextCaddy]]) {
    await writeFile(path.join(backup, name), text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  const script = path.resolve(process.argv[1]).replace(/'/g, "'\\''");
  console.log(`Private backups: ${backup}`);
  console.log(`Rollback: sudo node '${script}' --rollback ${id}`);
  console.log('IP HTTPS does not replace applicable mainland-server filing requirements.');
  validate(path.join(backup, 'proposed.env'), path.join(backup, 'proposed.Caddyfile'));
  let changed = false;
  try {
    changed = true;
    await atomicWrite(envFile, nextEnv, 0o600);
    await atomicWrite(caddyFile, nextCaddy, original.mode);
    console.log('Starting existing images; the app may take up to two minutes to become healthy.');
    start();
    console.log('Checking the public IP certificate and login protection (up to 90 seconds).');
    await waitForHttps();
    console.log(`Verified: https://${IP_ADDRESS}/ has a trusted IP certificate and requires the existing website login.`);
    console.log('Use this HTTPS address on your phone or other computer. Existing login credentials and learning data are unchanged.');
  } catch (error) {
    console.error(error.message);
    console.error(`Caddy diagnostics: ${logsCommand}`);
    if (changed) {
      // Capture the failing container before recreation removes its ACME logs.
      // Keep diagnostics private and never print configuration or credentials.
      try {
        const logs = docker([...compose(), 'logs', '--no-color', '--timestamps', '--tail', '100', 'caddy'], 'Caddy diagnostic capture');
        const diagnostic = path.join(backup, 'failed-caddy.log');
        await writeFile(diagnostic, Buffer.concat([logs.stdout || Buffer.alloc(0), logs.stderr || Buffer.alloc(0)]), { mode: 0o600, flag: 'wx' });
        console.error(`Saved private failure diagnostics: ${diagnostic}`);
      } catch { console.error('Could not preserve the failed container logs.'); }
      try { await restore(backup, original.mode); console.error('Restored the previous configuration and restarted its containers. IP HTTPS is not confirmed available.'); }
      catch { console.error(`Automatic restoration did not finish. Retry: sudo node '${script}' --rollback ${id}`); }
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
