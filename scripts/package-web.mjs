// Source-only deployment archive. No databases, keys, models or Windows modules.
import { copyFile, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootFiles = [
  'Dockerfile', '.dockerignore', 'compose.yaml', 'compose.shared.yaml',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html',
  'README.md', 'AGENTS.md', 'deployment-guide.html',
  'deploy/Caddyfile', 'deploy/Caddyfile.shared', 'deploy/nginx-site.conf.example',
  'deploy/.env.example', 'deploy/configure.mjs', 'deploy/install-docker-ubuntu.sh',
  'deploy/import-offline-images.sh', 'deploy/fix-healthcheck.mjs', 'deploy/enable-ip-https.mjs', 'deploy/update-release.sh',
  'scripts/package-web.mjs', 'scripts/package-offline.mjs', 'scripts/setup-speech-linux.mjs',
  'scripts/check-speech.mjs', 'scripts/check-progress-integrity.mjs', 'scripts/check-release-auth.mjs', 'scripts/validate-vocabulary-details.ts',
  'scripts/generate-vocabulary-details.ts', 'scripts/generate-vocabulary-audio.ts', 'scripts/review-vocabulary-attributes.ts',
  'deploy/migrate-session-auth.mjs', 'deploy/update-session-release.sh',
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
  await collectDirectory(base, 'public', sourceExtensions, files);
  const audioDirectory = path.join(base, 'public/vocabulary-audio');
  let audioManifest;
  try { audioManifest = JSON.parse(await readFile(path.join(audioDirectory, 'manifest.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (audioManifest) for (const asset of Object.values(audioManifest)) {
    if (!/^[a-f0-9]{64}\.wav$/.test(asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid vocabulary audio manifest.');
    const name = 'public/vocabulary-audio/' + asset.file;
    await safeFile(base, name);
    const bytes = await readFile(path.join(base, name));
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Vocabulary audio checksum mismatch.');
    files.push(name);
  }
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
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable release version.');
  await mkdir(path.join(root, 'releases'), { recursive: true });
  const temporary = path.join(root, 'releases', `nihongo-web-${process.pid}-${Date.now()}.tar.gz`);
  const output = path.join(root, 'releases', 'nihongo-web.tar.gz');
  await makeTar(files, temporary);
  await rename(temporary, output);
  const versioned = path.join(root, 'releases', `nihongo-web-v${version}.tar.gz`);
  await copyFile(output, versioned);
  const checksum = createHash('sha256').update(await readFile(output)).digest('hex');
  for (const archive of [output, versioned]) {
    await writeFile(archive + '.sha256', `${checksum}  ${path.basename(archive)}\n`);
  }
  console.log(`已打包 ${files.length} 个应用文件：${output}`);
  console.log(`版本存档：${versioned}\nSHA256: ${checksum}`);
  console.log('不含学习记录、API 密钥、.env、语音模型或 node_modules。');
  console.log('学习记录请从应用导出；语音模型单独上传。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
