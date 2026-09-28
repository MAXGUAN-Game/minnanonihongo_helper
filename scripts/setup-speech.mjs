import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if ((process.env.HTTPS_PROXY || process.env.HTTP_PROXY) && !process.execArgv.includes('--use-env-proxy') && process.env.NODE_USE_ENV_PROXY !== '1') {
  const child = spawnSync(process.execPath, ['--use-env-proxy', fileURLToPath(import.meta.url)], { stdio: 'inherit', windowsHide: true });
  process.exit(child.status ?? 1);
}
const speechDir = path.join(root, 'data', 'speech');
const model = path.join(speechDir, 'ggml-small.bin');
const manifestPath = path.join(speechDir, 'install.json');
await mkdir(speechDir, { recursive: true });
const hashFile = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
async function download(url, target, expectedHash) {
  const partial = target + '.download';
  console.log('Downloading: ' + path.basename(target));
  const response = await fetch(url, { signal: AbortSignal.timeout(20 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  let bytes = 0, last = Date.now(); const size = Number(response.headers.get('content-length'));
  const input = Readable.fromWeb(response.body);
  input.on('data', chunk => { bytes += chunk.length; if (Date.now() - last > 10000) { console.log(`${Math.round(bytes / 1048576)} MB${size ? ' / ' + Math.round(size / 1048576) + ' MB' : ''}`); last = Date.now(); } });
  try {
    await pipeline(input, createWriteStream(partial));
    const hash = await hashFile(partial);
    if (expectedHash && hash !== expectedHash) throw new Error('Downloaded file checksum does not match. Please retry.');
    await rename(partial, target);
    return hash;
  } catch (error) { await rm(partial, { force: true }); throw error; }
}
async function findBinary(dir) {
  if (!existsSync(dir)) return null;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === 'whisper-cli.exe') return full;
    if (entry.isDirectory()) { const found = await findBinary(full); if (found) return found; }
  }
  return null;
}

// Windows releases an exclusive file handle even after a crash. The file itself may
// remain: its existence is diagnostic, never evidence that an installer is active.
// The helper's stdin closes when this Node process dies, so it cannot orphan a lock.
async function acquireInstallationLock(directory) {
  if (process.platform !== 'win32') throw new Error('Local speech setup currently supports Windows PCs.');
  const lockScript = `
$ErrorActionPreference = 'Stop'
$lockHandle = $null
try {
  $lockHandle = [IO.File]::Open($env:NIHONGO_SPEECH_LOCK, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $metadata = @{ pid = [int]$env:NIHONGO_SETUP_PID; startedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($metadata)
  $lockHandle.SetLength(0)
  $lockHandle.Write($bytes, 0, $bytes.Length)
  $lockHandle.Flush($true)
  [Console]::Out.WriteLine('LOCKED')
  [Console]::Out.Flush()
  [Console]::ReadLine() | Out-Null
} catch [IO.IOException] {
  $nativeCode = $_.Exception.HResult -band 65535
  if ($nativeCode -eq 32 -or $nativeCode -eq 33) {
    [Console]::Out.WriteLine('BUSY')
    exit 2
  }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($lockHandle) { $lockHandle.Dispose() }
}
`;
  const guard = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(lockScript, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NIHONGO_SPEECH_LOCK: path.join(directory, '.install.lock'), NIHONGO_SETUP_PID: String(process.pid) },
  });
  guard.stdin.on('error', () => {});
  let acquired = false, releasing = false;
  const result = await new Promise((resolve, reject) => {
    let output = '', errors = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (error) { releasing = true; guard.kill(); reject(error); }
      else resolve(value);
    };
    const deadline = setTimeout(() => finish(new Error('Timed out acquiring the speech installation lock. Please retry.')), 15000);
    guard.stdout.setEncoding('utf8'); guard.stderr.setEncoding('utf8');
    guard.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('LOCKED')) { acquired = true; finish(null, true); }
      else if (output.includes('BUSY')) finish(null, false);
    });
    guard.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    guard.once('error', error => finish(new Error('Unable to start the speech installation lock: ' + error.message)));
    guard.once('exit', code => {
      if (acquired && !releasing) {
        console.error('Speech installation lock was lost. Installation stopped; please retry.');
        process.exit(1);
      }
      if (!settled) finish(new Error(errors.trim() || `Speech installation lock exited unexpectedly (${code}).`));
    });
  });
  if (!result) { guard.stdin.end(); return null; }
  return async () => {
    releasing = true;
    if (guard.exitCode !== null) return;
    await new Promise(resolve => {
      const deadline = setTimeout(() => { guard.kill(); resolve(); }, 3000);
      guard.once('exit', () => { clearTimeout(deadline); resolve(); });
      guard.stdin.end('\n');
    });
  };
}

let releaseInstallationLock;
try {
  releaseInstallationLock = await acquireInstallationLock(speechDir);
  if (!releaseInstallationLock) {
    console.log('Local speech installation is already running. Please wait; you can keep studying with text.');
    process.exitCode = 0;
  } else {
  let binary = await findBinary(path.join(speechDir, 'runtime'));
  if (!binary) {
    const zip = path.join(speechDir, 'whisper-v1.9.2-x64.zip');
    const expected = '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a';
    if (!existsSync(zip) || await hashFile(zip) !== expected) await download('https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip', zip, expected);
    const runtime = path.join(speechDir, 'runtime');
    await mkdir(runtime, { recursive: true });
    const extract = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:NIHONGO_ZIP -DestinationPath $env:NIHONGO_RUNTIME -Force'], { env: { ...process.env, NIHONGO_ZIP: zip, NIHONGO_RUNTIME: runtime }, windowsHide: true, encoding: 'utf8' });
    if (extract.status !== 0) throw new Error('Unable to extract speech runtime: ' + extract.stderr);
    binary = await findBinary(runtime);
    if (!binary) throw new Error('Downloaded archive did not contain whisper-cli.exe.');
  }
  let old = {}; try { old = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}
  let modelHash = old.modelHash;
  if (!existsSync(model) || (await stat(model)).size < 400000000) {
    const response = await fetch('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const etag = (response.headers.get('x-linked-etag') || '').replaceAll('"', '');
    if (!/^[a-f0-9]{64}$/.test(etag)) throw new Error('Cannot verify the model checksum from the official model host. Retry when the network is available.');
    modelHash = await download('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', model, etag);
  } else if (modelHash && await hashFile(model) !== modelHash) throw new Error('The installed model failed its checksum check. Rename data/speech/ggml-small.bin and run setup again.');
  const check = spawnSync(binary, ['--help'], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  if (check.error || ![0, 1].includes(check.status)) throw new Error('Speech runtime could not start. Please install the Microsoft Visual C++ x64 runtime.');
  await writeFile(manifestPath, JSON.stringify({ version: '1.9.2', binary: path.relative(speechDir, binary), model: 'ggml-small.bin', modelHash, installedAt: new Date().toISOString() }, null, 2));
  console.log('Local Japanese speech recognition is ready.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (releaseInstallationLock) await releaseInstallationLock(); }
