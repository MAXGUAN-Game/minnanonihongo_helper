// Read-only component diagnostics. A real recording is still needed to verify
// that the model loads and Japanese transcription works.
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSpeechStatus, speechPaths } from '../src/server/speech.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  // Match the server's configuration without printing environment variables.
  const localEnvironment = path.join(root, '.env.local');
  if (existsSync(localEnvironment)) process.loadEnvFile(localEnvironment);
  const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
  const paths = speechPaths(dataDir);
  const status = getSpeechStatus(dataDir);
  let binaryStarts = false, binaryError;
  if (status.binaryReady) {
    const check = spawnSync(paths.binary, ['--help'], {
      windowsHide: true, timeout: 20000, killSignal: 'SIGKILL', stdio: 'ignore',
    });
    binaryStarts = !check.error && [0, 1].includes(check.status);
    if (!binaryStarts) binaryError = check.error?.code || check.signal || `EXIT_${check.status}`;
  }
  const componentsReady = status.ready && binaryStarts;
  console.log(JSON.stringify({
    dataDir, binary: paths.binary, model: paths.model,
    ...status, binaryStarts, ...(binaryError ? { binaryError } : {}),
    ...(status.modelReady ? { modelBytes: statSync(paths.model).size } : {}),
    componentsReady, modelLoadVerified: false,
  }, null, 2));

  if (componentsReady) {
    console.log('语音组件预检查通过；尚未验证模型加载或识别结果。请在网页录制一句日语，确认能转成文字。');
    console.log('如仍提示模型加载失败，请核对模型 SHA-256，并在确认文件损坏后重新上传完整模型。');
    return;
  }
  process.exitCode = 1;
  if (process.platform === 'win32' && process.env.DEPLOYMENT !== 'web') {
    console.error('请在项目目录运行 npm.cmd run setup:speech，或双击“安装本机语音.cmd”，然后重新检查。');
  } else {
    if (!status.binaryReady || !binaryStarts) console.error('识别程序无法启动。请核对上方 binary 路径、执行权限与运行库；Docker 部署应使用含 Linux whisper-cli 的应用镜像。');
    if (!status.modelReady) console.error('模型无法读取。请把完整的多语言 ggml-small.bin 上传到上方 model 路径，或在 app 容器执行 node scripts/setup-speech-linux.mjs --download-model。');
    console.error('修复步骤见 docs/speech-troubleshooting.md；准备完成后重新检查，并用网页录音验收。');
  }
}

try { main(); }
catch {
  // Avoid echoing parsed configuration, subprocess output or environment secrets.
  console.error('无法完成语音检查。请检查 DATA_DIR、WHISPER_BINARY、WHISPER_MODEL 路径配置与数据目录权限；语音程序和模型的覆盖路径必须是绝对路径。');
  process.exitCode = 1;
}
