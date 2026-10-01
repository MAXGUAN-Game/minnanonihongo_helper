// Source-only deployment archive. No databases, keys, models or Windows modules.
import { lstat, mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootFiles = [
  'Dockerfile', '.dockerignore', 'compose.yaml', 'compose.shared.yaml',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html',
  'README.md', 'deployment-guide.html',
  'deploy/Caddyfile', 'deploy/Caddyfile.shared', 'deploy/nginx-site.conf.example',
  'deploy/.env.example', 'deploy/configure.mjs', 'deploy/install-docker-ubuntu.sh',
  'deploy/import-offline-images.sh', 'deploy/fix-healthcheck.mjs', 'deploy/enable-ip-https.mjs', 'deploy/update-release.sh',
  'scripts/package-web.mjs', 'scripts/package-offline.mjs', 'scripts/setup-speech-linux.mjs',
  'scripts/refresh-textbook-audio.mjs',
];
const sourceExtensions = new Set(['.ts', '.tsx', '.css', '.svg', '.png', '.webp', '.woff2', '.json', '.md']);

async function safeFile(base, relative) {
  if (/[\r\n]/.test(relative) || relative.split('/').some(part => part === '..') || path.isAbsolute(relative)) throw new Error('Unexpected package path.');
  const parts = relative.split('/');
  for (let index = 1; index < parts.length; index++) {
    const parent = await lstat(path.join(base, ...parts.slice(0, index)));
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error(`Source path contains a link or non-directory: ${relative}`);
  }
  const entry = await lstat(path.join(base, relative));
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Expected a regular source file: ${relative}`);
}

async function collectDirectory(base, relative, accepted, output) {
  const directory = await lstat(path.join(base, relative));
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error(`Expected a source directory: ${relative}`);
  for (const entry of await readdir(path.join(base, relative), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const name = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not packaged: ${name}`);
    if (entry.isDirectory()) await collectDirectory(base, name, accepted, output);
    else if (entry.isFile() && accepted.has(path.extname(entry.name).toLowerCase())) { await safeFile(base, name); output.push(name); }
  }
}

export async function collectPackageFiles(base = root) {
  const files = [...rootFiles];
  for (const name of files) await safeFile(base, name);
  await collectDirectory(base, 'src', sourceExtensions, files);
  await collectDirectory(base, 'docs', new Set(['.md']), files);
  return [...new Set(files)].sort();
}

async function makeTar(files, output) {
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', output, '-T', '-'], { cwd: root, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('error', error => reject(new Error(error.code === 'ENOENT' ? '找不到 tar；请使用 Windows 10/11 自带的 tar 或在 Linux 上打包。' : error.message)));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`打包失败：${diagnostic.trim() || `tar exit ${code}`}`)));
    child.stdin.end(files.join('\n') + '\n');
  });
}

async function main() {
  const files = await collectPackageFiles();
  if (process.argv.includes('--list')) { console.log(files.join('\n')); return; }
  await mkdir(path.join(root, 'releases'), { recursive: true });
  const temporary = path.join(root, 'releases', `nihongo-web-${process.pid}-${Date.now()}.tar.gz`);
  const output = path.join(root, 'releases', 'nihongo-web.tar.gz');
  await makeTar(files, temporary);
  await rename(temporary, output);
  console.log(`已打包 ${files.length} 个应用文件：${output}`);
  console.log('不含学习记录、API 密钥、.env、语音模型或 node_modules。');
  console.log('学习记录请从应用导出；语音模型单独上传。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
