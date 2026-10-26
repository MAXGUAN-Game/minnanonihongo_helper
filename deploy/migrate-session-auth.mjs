// Pure transforms preserve custom TLS/IP HTTPS and existing environment values.
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function migrateCaddy(text) {
  const block = /([\t ]*)basic_auth\s*\{\s*\{\$APP_AUTH_USER\}\s+\{\$APP_AUTH_HASH\}\s*\}\s*\r?\n/g;
  const matches = [...text.matchAll(block)];
  if (matches.length > 1 || (!matches.length && !text.includes('# Application session authentication') && !text.includes('# The application verifies persistent version-bound sessions'))) throw new Error('Unrecognized authentication layout; configuration was not changed.');
  let result = matches.length ? text.replace(block, '$1# Application session authentication\n') : text;
  if (!/header_up X-Nihongo-Proxy \{\$APP_PROXY_TOKEN\}/.test(result) || !/reverse_proxy app:4317/.test(result)) throw new Error('Unrecognized proxy boundary.');
  if (!result.includes('header_up X-Nihongo-Client-IP')) result = result.replace('header_up -Authorization', 'header_up -Authorization\n\t\t\theader_up X-Nihongo-Client-IP {http.request.remote.host}');
  if (result.includes('basic_auth')) throw new Error('Unexpected extra basic authentication.');
  return result;
}
export function migrateCompose(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'; text = text.replace(/\r\n/g, '\n');
  const start = text.indexOf('\n  app:\n'), end = text.indexOf('\n  caddy:\n');
  if (start < 0 || end <= start) throw new Error('Expected standard app and caddy services.');
  let app = text.slice(start, end);
  if (!app.includes('./server-data:/app/data') || !app.includes('APP_PROXY_TOKEN:')) throw new Error('Unexpected app data mount or proxy configuration.');
  if (!app.includes('      APP_AUTH_HASH:')) app = app.replace('    environment:\n', '    environment:\n      APP_AUTH_USER: "${APP_AUTH_USER:?Existing login username is required}"\n      APP_AUTH_HASH: "${APP_AUTH_HASH:?Existing bcrypt hash is required}"\n');
  return (text.slice(0, start) + app + text.slice(end)).replace(/\n/g, newline);
}
async function stage(runtime, destination) {
  if (resolve(runtime) === resolve(destination)) throw new Error('Staging must be separate from runtime.');
  for (const file of ['compose.yaml', 'deploy/Caddyfile', '.env']) {
    if (!(await lstat(resolve(runtime, file))).isFile()) throw new Error('Expected regular runtime files.');
  }
  const env = await readFile(resolve(runtime, '.env'), 'utf8');
  if (!/^APP_AUTH_USER=.+$/m.test(env) || !/^APP_AUTH_HASH=.+$/m.test(env)) throw new Error('Existing login credentials are missing.');
  await mkdir(resolve(destination, 'deploy'), { recursive: true });
  await writeFile(resolve(destination, 'compose.yaml'), migrateCompose((await readFile(resolve(runtime, 'compose.yaml'), 'utf8')).replace(/\r\n/g, '\n')), { mode: 0o600 });
  await writeFile(resolve(destination, 'deploy/Caddyfile'), migrateCaddy((await readFile(resolve(runtime, 'deploy/Caddyfile'), 'utf8')).replace(/\r\n/g, '\n')), { mode: 0o600 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node migrate-session-auth.mjs RUNTIME STAGING');
  await stage(process.argv[2], process.argv[3]); console.log('Staged session authentication configuration; runtime unchanged.');
}
