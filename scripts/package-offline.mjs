// Package verified official Linux images with the application source allowlist.
import { createReadStream } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPackageFiles } from './package-web.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releases = path.join(root, 'releases');
const archives = ['caddy-2.11.4-alpine-linux-amd64.tar', 'debian-bookworm-slim-linux-amd64.tar', 'node-24-bookworm-linux-amd64.tar', 'node-24-bookworm-slim-linux-amd64.tar'];
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const imageFiles = [];
for (const name of archives) {
  const file = path.join(releases, 'offline-images', name);
  const checksumFile = file + '.sha256';
  const recorded = (await readFile(checksumFile, 'utf8')).trim();
  const checksum = await sha256(file);
  if (recorded !== `${checksum}  ${name}`) throw new Error(`Image verification failed: ${name}`);
  const metadataFile = file + '.metadata.json';
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  if (metadata.archive !== name || metadata.archiveSha256 !== checksum || metadata.platform !== 'linux/amd64'
    || metadata.validation?.craneFullValidationPassed !== true
    || metadata.validation?.archiveConfigMatchesRegistry !== true
    || metadata.validation?.compressedLayerDigestsMatchRegistry !== true
    || metadata.validation?.architectureVerified !== true
    || metadata.validation?.independentTarBlobSha256Verified !== true) {
    throw new Error(`Image provenance or full validation is missing: ${name}`);
  }
  imageFiles.push(`offline-images/${name}`, `offline-images/${name}.sha256`, `offline-images/${name}.metadata.json`);
}
const sourceFiles = await collectPackageFiles();
const temporary = path.join(releases, `nihongo-offline-install-${process.pid}.tar.gz`);
const output = path.join(releases, 'nihongo-offline-install.tar.gz');
await new Promise((resolve, reject) => {
  const child = spawn('tar', ['-czf', temporary, '-C', root, ...sourceFiles, '-C', releases, ...imageFiles], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`Archive failed: ${diagnostic}`)));
});
await rename(temporary, output);
await writeFile(output + '.sha256', `${await sha256(output)}  ${path.basename(output)}\n`);
console.log(`Offline install bundle: ${output}`);
console.log(`Size: ${Math.round((await stat(output)).size / 1048576)} MiB; source files: ${sourceFiles.length}; official images: ${archives.length}`);
console.log('No learning data, API keys, .env or speech model included. Application build still needs APT/npm/GitHub access.');
