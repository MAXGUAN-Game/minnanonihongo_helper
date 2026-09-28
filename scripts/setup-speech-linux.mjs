import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const minimumModelBytes = 400000000;
const args = process.argv.slice(2);
const usage = `Prepare Japanese speech recognition on Linux (the Docker image already includes whisper-cli).

  node scripts/setup-speech-linux.mjs
      Check and reuse an uploaded data/speech/ggml-small.bin; no model download.
  node scripts/setup-speech-linux.mjs --download-model
      Download a missing model from the official model repository and verify SHA-256.
  node scripts/setup-speech-linux.mjs --sha256 <64-character SHA-256>
      Verify an uploaded model against a checksum you saved on the source computer.

Environment: DATA_DIR, WHISPER_BINARY (absolute path), WHISPER_MODEL (absolute path).
This script does not install system packages or build whisper.cpp.`;

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function absoluteOverride(value, fallback, name) {
  if (!value?.trim()) return fallback;
  if (!path.isAbsolute(value.trim())) throw new Error(`${name} must be an absolute path.`);
  return path.normalize(value.trim());
}
async function existingFile(file) {
  try { return await stat(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function downloadModel(model, expectedHash) {
  if (!expectedHash) {
    const response = await fetch(modelUrl, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(30000) });
    expectedHash = (response.headers.get('x-linked-etag') || '').replaceAll('"', '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('The official repository did not supply a verifiable SHA-256. Upload your existing model and its checksum instead.');
  }
  await mkdir(path.dirname(model), { recursive: true });
  const partial = `${model}.${randomUUID()}.download`;
  try {
    console.log('Downloading the multilingual small model from the official model repository...');
    const response = await fetch(modelUrl, { signal: AbortSignal.timeout(20 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`Model download failed (HTTP ${response.status}). Upload your existing model instead.`);
    const input = Readable.fromWeb(response.body);
    let bytes = 0, reportedAt = Date.now();
    input.on('data', chunk => {
      bytes += chunk.length;
      if (Date.now() - reportedAt > 10000) { console.log(`Downloaded ${Math.round(bytes / 1048576)} MiB...`); reportedAt = Date.now(); }
    });
    await pipeline(input, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
    if ((await stat(partial)).size < minimumModelBytes) throw new Error('The downloaded model is incomplete.');
    const actualHash = await hashFile(partial);
    if (actualHash !== expectedHash) throw new Error('The model checksum does not match; the downloaded file was discarded.');
    // The destination is populated only after the complete download passes validation.
    await rename(partial, model);
    return actualHash;
  } finally { await rm(partial, { force: true }); }
}

async function main() {
  let allowDownload = false, expectedHash;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--download-model') allowDownload = true;
    else if (value === '--sha256') {
      expectedHash = args[++index]?.toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedHash || '')) throw new Error('--sha256 requires a 64-character SHA-256 checksum.');
    } else throw new Error(`Unknown argument: ${value}. Run with --help for instructions.`);
  }
  if (process.platform !== 'linux') throw new Error('Run this script on your Linux server or in its app container. On Windows, use the existing speech installation shortcut.');
  const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
  const base = path.join(dataDir, 'speech');
  const binary = absoluteOverride(process.env.WHISPER_BINARY, path.join(base, 'runtime', 'bin', 'whisper-cli'), 'WHISPER_BINARY');
  const model = absoluteOverride(process.env.WHISPER_MODEL, path.join(base, 'ggml-small.bin'), 'WHISPER_MODEL');
  const check = spawnSync(binary, ['--help'], { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  if (check.error || ![0, 1].includes(check.status)) throw new Error('whisper-cli could not start. Use the provided Docker image or set WHISPER_BINARY to a working Linux binary.');

  if (!expectedHash) {
    for (const name of ['install-linux.json', 'install.json']) {
      try {
        const metadata = JSON.parse(await readFile(path.join(base, name), 'utf8'));
        if (path.resolve(base, metadata.model || 'ggml-small.bin') === model && /^[a-f0-9]{64}$/i.test(metadata.modelHash || '')) { expectedHash = metadata.modelHash.toLowerCase(); break; }
      } catch { /* Missing checksum metadata does not prevent checking an uploaded model. */ }
    }
  }
  const existing = await existingFile(model);
  let modelHash;
  if (existing) {
    if (!existing.isFile() || existing.size < minimumModelBytes) throw new Error('The uploaded multilingual small model is incomplete. Upload the complete ggml-small.bin before retrying.');
    modelHash = await hashFile(model);
    if (expectedHash && expectedHash !== modelHash) throw new Error('The uploaded model checksum does not match. The file was left unchanged; upload it again.');
    console.log(expectedHash ? 'Reused the existing model; SHA-256 matches the saved checksum.' : 'Reused the existing model. Its fingerprint is recorded; source authenticity was not independently verified.');
  } else {
    if (!allowDownload) throw new Error(`The model is missing. Upload ggml-small.bin to ${model}, then retry; or explicitly add --download-model.`);
    modelHash = await downloadModel(model, expectedHash);
    console.log('Downloaded model passed SHA-256 checksum verification.');
  }
  await mkdir(base, { recursive: true });
  const manifest = path.join(base, 'install-linux.json');
  const temporary = `${manifest}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: '1.9.2', binary: path.relative(base, binary), model: path.relative(base, model), modelHash, installedAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, manifest);
  } finally { await rm(temporary, { force: true }); }
  console.log(`Model SHA-256: ${modelHash}`);
  console.log('Speech files are prepared. Test a short Japanese recording in the app to verify recognition and measure latency.');
}

if (args.includes('--help')) console.log(usage);
else {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
