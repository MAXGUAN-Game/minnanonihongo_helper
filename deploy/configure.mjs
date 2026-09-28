// Existing website: sudo node deploy/configure.mjs --shared
// New independent server: sudo node deploy/configure.mjs
// Host Node 18+ is enough for this helper; the app image uses Node 24.
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, chown, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const caddyImage = 'caddy:2.11.4-alpine';

export function validDomain(value) {
  return value.length <= 253 && value.includes('.') && value.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) && /[a-z]$/.test(value);
}

export function validUsername(value) { return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(value); }

export function validPassword(value) {
  return [...value].length >= 12 && Buffer.byteLength(value, 'utf8') <= 72 && value === value.trim() && !/[\r\n\u0000-\u001f\u007f]/.test(value);
}

function hiddenQuestion(prompt) {
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = Boolean(process.stdin.isRaw);
    const cleanup = () => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onKey = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') { cleanup(); reject(new Error('已取消；没有保存新配置。')); return; }
      if (key.name === 'return' || key.name === 'enter') { cleanup(); resolve(value); return; }
      if (key.name === 'backspace') {
        if (value.length) { value = [...value].slice(0, -1).join(''); process.stdout.write('\b \b'); }
        return;
      }
      if (key.ctrl || key.meta || !character || /[\r\n\u0000-\u001f\u007f]/.test(character)) return;
      value += character;
      process.stdout.write('*'.repeat([...character].length));
    };
    process.stdout.write(prompt);
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', onKey);
    process.stdin.resume();
  });
}

export function ensureCaddyImage({ run = spawnSync, log = console.log, shared = false } = {}) {
  const docker = run('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
  if (docker.status !== 0) throw new Error(shared
    ? 'Docker 尚未就绪或当前用户没有权限。先确认现有服务器的操作系统、面板和容器环境；已有网站时不要直接重装系统或替换 Docker。'
    : 'Docker 尚未就绪或当前用户没有权限。请先检查 sudo docker version；新的 Ubuntu 24.04 服务器尚未安装 Docker 时，再使用安装脚本。');
  const inspect = () => run('docker', ['image', 'inspect', caddyImage], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
  if (inspect().status === 0) { log('已找到本地 Caddy 镜像，跳过下载。'); return; }

  log(`本地缺少 ${caddyImage}，先准备镜像，成功后再填写网站密码。`);
  log('下面显示 Docker 的下载进度或原始错误；当前还没有读取密码。');
  // At this point no password has been requested. Preserve Docker's real pull
  // diagnostic so a network failure is not confused with a hashing failure.
  const pulled = run('docker', ['pull', caddyImage], { stdio: 'inherit', windowsHide: true, timeout: 180_000 });
  if (pulled.status !== 0) {
    const reason = pulled.error?.code === 'ETIMEDOUT' ? '镜像下载等待超时' : pulled.error?.code === 'ENOENT' ? 'Docker 命令未能启动' : `镜像下载失败${Number.isInteger(pulled.status) ? `（退出码 ${pulled.status}）` : ''}`;
    throw new Error(`${reason}；还没有读取密码或修改配置。请查看上面的 Docker 错误。\n若 Docker Hub 连接超时，可先用 sudo docker load -i 镜像文件.tar 导入官方 Caddy 镜像，再重新运行本配置命令；无需修改已有 .env。`);
  }
  if (inspect().status !== 0) throw new Error('下载命令已结束，但仍未找到本地 Caddy 镜像。还没有读取密码或修改配置；请检查 Docker 镜像列表或重新离线导入。');
  log('Caddy 镜像已准备好。');
}

export async function confirmAndPrepare({ existingConfig, question, shared = false, prepareImage = ensureCaddyImage, log = console.log }) {
  if (existingConfig) {
    const replace = await question('已经有网站配置。确实要更换登录设置时输入 UPDATE，否则直接回车退出：');
    if (replace !== 'UPDATE') {
      log('保留已有配置。');
      if (shared) log('共存启动仍使用：sudo docker compose -f compose.shared.yaml up -d --build\n同时配置现有网关的新子域名 HTTPS 反向代理；只有外层 HTTPS 生效后才登录和使用麦克风。');
      return false;
    }
  }
  await prepareImage({ shared, log });
  return true;
}

export function hashPassword(password, { spawnProcess = spawn, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    // No shell, command-line password, or environment variable contains the password.
    let child;
    try {
      child = spawnProcess('docker', ['run', '--pull=never', '--rm', '-i', caddyImage, 'caddy', 'hash-password', '--algorithm', 'bcrypt'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch { reject(new Error('Docker 密码处理命令未能启动；配置未写入。请检查 Docker 安装及运行权限。')); return; }
    let output = '', diagnostic = '', settled = false;
    const finish = (error, hash) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(hash);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('密码处理等待超时；配置未写入。Caddy 镜像已在本地，本次加密没有下载镜像；请检查 Docker 运行状态后重试。'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(0, 4096); });
    // Use a bounded diagnostic ONLY for classification; never echo it because
    // a failed child process could include the password or its hash in stderr.
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('Docker 密码处理命令未能启动；配置未写入。请检查 Docker 安装及运行权限。')));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        let message;
        if (/no such image|unable to find image|pull access denied/i.test(diagnostic)) message = '本地 Caddy 镜像不可用；密码处理禁止自动下载，配置未写入。请重新离线导入镜像后运行配置。';
        else if (/cannot connect to the docker daemon|permission denied|access is denied/i.test(diagnostic)) message = 'Docker 服务连接或权限检查失败；配置未写入。请检查 sudo docker version 后重试。';
        else if ([125, 126, 127].includes(code)) message = `Docker 未能启动 Caddy 密码处理容器（退出码 ${code}）；配置未写入。请检查本地镜像和 Docker 运行状态。`;
        else message = `Caddy 密码处理失败${Number.isInteger(code) ? `（退出码 ${code}）` : '（进程中断）'}；配置未写入。请重试；子进程原始输出已隐藏，避免泄露密码。`;
        finish(new Error(message)); return;
      }
      const hash = output.trim();
      if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) { finish(new Error('Caddy 已退出，但返回的密码哈希格式不正确；配置未写入。请检查 Caddy 镜像版本；原始输出已隐藏。')); return; }
      finish(undefined, hash);
    });
    child.stdin.end(password + '\n');
  });
}

export function renderEnv({ domain, username, hash, token, uid, gid, icpNumber = '' }) {
  if (!validDomain(domain) || !validUsername(username) || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash) || !/^[a-f0-9]{64}$/.test(token) || !Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1) throw new Error('配置校验失败；没有保存。');
  if (icpNumber.length > 64 || !/^[\p{L}\p{N} -]*$/u.test(icpNumber)) throw new Error('备案号请只填写真实号码（例如省份简称、ICP、数字和短横线），不要填写网址。');
  return [
    '# Generated by deploy/configure.mjs. Keep this file private.',
    `APP_DOMAIN=${domain}`,
    `APP_AUTH_USER=${username}`,
    `APP_AUTH_HASH='${hash}'`,
    `APP_PROXY_TOKEN=${token}`,
    `APP_UID=${uid}`,
    `APP_GID=${gid}`,
    `ICP_NUMBER='${icpNumber}'`,
    '',
  ].join('\n');
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some(value => !['--help', '--shared'].includes(value))) throw new Error('未知参数。已有网站共存部署请运行 sudo node deploy/configure.mjs --shared。');
  const shared = arguments_.includes('--shared');
  if (process.argv.includes('--help')) {
    console.log('已有网站共存部署：sudo node deploy/configure.mjs --shared\n独立空闲服务器：sudo node deploy/configure.mjs\n依次填写域名、登录名和网站密码。密码不会明文显示。\n共存模式由现有网站网关提供 HTTPS，容器只监听主机 127.0.0.1:14317。');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在可交互的服务器终端中运行此命令；密码不接受命令行参数。');
  const destination = path.join(root, '.env');
  if (shared) console.log('共存模式：保留原网站。现有 Nginx / 宝塔负责新子域名的 HTTPS；容器只开放主机回环端口 14317。');
  console.log('设置你自己的网页登录密码。AI 服务密钥稍后在网站“设置”中填写。');
  const questions = createInterface({ input: process.stdin, output: process.stdout });
  let domain, username, icpNumber;
  try {
    if (!await confirmAndPrepare({ existingConfig: existsSync(destination), question: prompt => questions.question(prompt), shared })) return;
    domain = (await questions.question('网站域名 [jp.nbblearnjp.xyz]：')).trim().toLowerCase() || 'jp.nbblearnjp.xyz';
    if (!validDomain(domain)) throw new Error('请只填写域名，例如 jp.nbblearnjp.xyz，不带 https:// 或路径。');
    username = (await questions.question('网站登录名 [learner]：')).trim() || 'learner';
    if (!validUsername(username)) throw new Error('登录名限 1–32 位英文、数字、下划线或短横线。');
    icpNumber = (await questions.question('已有的真实 ICP 备案号（可暂时留空，稍后补全）：')).trim();
    if (icpNumber.length > 64 || !/^[\p{L}\p{N} -]*$/u.test(icpNumber)) throw new Error('备案号只填写号码本身，不要填写网址；可以暂时留空。');
  } finally { questions.close(); }
  let password = await hiddenQuestion('网站密码（至少 12 位，输入时显示星号）：');
  if (!validPassword(password)) throw new Error('密码至少 12 个字符，最多 72 个 UTF-8 字节，首尾不能留空格。请重新运行配置命令。');
  let repeated = await hiddenQuestion('再输入一次密码：');
  if (password !== repeated) throw new Error('两次密码不同；没有保存配置，请重新运行。');
  console.log('正在使用已准备好的本地 Caddy 镜像加密密码，不再下载镜像。');
  const hash = await hashPassword(password);
  password = ''; repeated = '';
  const rootUser = typeof process.getuid === 'function' && process.getuid() === 0;
  const uid = rootUser ? 1000 : (process.getuid?.() || 1000);
  const gid = rootUser ? 1000 : (process.getgid?.() || 1000);
  const dataPath = path.join(root, 'server-data');
  await mkdir(dataPath, { recursive: true, mode: 0o700 });
  await mkdir(path.join(dataPath, 'speech'), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(dataPath, 0o700);
    if (rootUser) { await chown(dataPath, uid, gid); await chown(path.join(dataPath, 'speech'), uid, gid); }
  }
  const output = renderEnv({ domain, username, hash, token: randomBytes(32).toString('hex'), uid, gid, icpNumber });
  const temporary = destination + `.pending-${process.pid}`;
  await writeFile(temporary, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, destination);
  if (process.platform !== 'win32') await chmod(destination, 0o600);
  const startCommand = shared ? 'sudo docker compose -f compose.shared.yaml up -d --build' : 'sudo docker compose up -d --build';
  console.log(`配置已保存。网站地址：https://${domain}\n下一步：${startCommand}\n启动后，用刚才设置的登录名和密码进入网站。`);
  if (shared) console.log('还需在现有网关的新子域名站点配置 HTTPS 与反向代理，参考 deploy/nginx-site.conf.example。\n外层 HTTPS 生效后再登录、允许麦克风。原网关若运行在 Docker 中，需要先确认容器网络；不要把 14317 开放到公网。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
