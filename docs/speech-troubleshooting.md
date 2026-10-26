# 语音识别排查与恢复

“语音识别服务尚未准备好”表示服务器没有找到可用的识别程序或模型。这个检查发生在处理录音内容之前，反复录音不能修复缺失的组件。

应用镜像包含 Linux 版 `whisper-cli`，模型需要单独准备。源码包、Git 仓库和基础镜像离线包不包含约 0.5 GB 的 `ggml-small.bin`；电脑上安装了模型，不代表服务器已经安装。`app healthy` 和版本更新的 `UPDATE_OK` 只检查网站运行状态，不检查模型加载或实际识别。

以下命令针对现有独立部署目录 `/opt/nihongo`。共存部署将 `-f compose.yaml` 改为 `-f compose.shared.yaml`。不要在 `/opt/nihongo-src` 执行这些 Compose 命令。

## 1. 先检查运行中的容器

新镜像包含只读诊断脚本：

```bash
cd /opt/nihongo
sudo docker compose -p nihongo-web -f compose.yaml exec -T app \
  node --import tsx scripts/check-speech.mjs
```

脚本输出实际数据目录、程序与模型路径、文件状态，以及程序是否能启动；不下载模型、不修改数据、不输出环境密钥。组件缺失或无法启动时返回非零退出码。`componentsReady: true` 仅表示组件预检查通过；`modelLoadVerified: false` 提醒你还需用真实录音验证模型加载与识别结果。

**当前旧镜像可能没有这个脚本。无需先升级网页，直接运行以下诊断：**

```bash
cd /opt/nihongo
sudo docker compose -p nihongo-web -f compose.yaml exec -T app \
  node --import tsx --input-type=module <<'NODE'
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getSpeechStatus, speechPaths } from './src/server/speech.ts';
const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || 'data');
const paths = speechPaths(dataDir);
const status = getSpeechStatus(dataDir);
const check = status.binaryReady
  ? spawnSync(paths.binary, ['--help'], { stdio: 'ignore', timeout: 20000, killSignal: 'SIGKILL' })
  : null;
const binaryStarts = Boolean(check && !check.error && [0, 1].includes(check.status));
console.log(JSON.stringify({ dataDir, ...paths, ...status, binaryStarts, modelLoadVerified: false }, null, 2));
process.exitCode = status.ready && binaryStarts ? 0 : 1;
NODE
```

默认应检查 `/opt/whisper/bin/whisper-cli` 和 `/app/data/speech/ggml-small.bin`。容器内 `/app/data` 对应宿主机 `/opt/nihongo/server-data`。旧版的 `binaryReady` / `modelReady` 只检查文件存在；即使显示 `ready: true`，仍需执行安装校验与第 3 步验收。

| 结果 | 下一步 |
| --- | --- |
| `modelReady: false` | 按第 2 步准备模型，核对上传目录和读取权限。 |
| `binaryReady: false` 或 `binaryStarts: false` | 核对 `WHISPER_BINARY`、执行权限和应用镜像；Linux 容器不能使用 Windows 的 `.exe`。正常镜像已包含程序，单独下载模型不能补上程序。 |
| 文件就绪但录音提示模型加载失败 | 先校验模型完整性和 SHA-256，确认使用多语言模型；文件存在不等于能够加载。 |
| 能生成文字但内容不正确 | 服务已经进入识别阶段，再检查录音声音、语言和实际识别效果。 |

## 2. 准备模型

两种方式任选一种。已有完整模型时优先上传，避免服务器访问模型下载源不畅。

### 下载显示 `fetch failed` 时

这个错误来自模型下载请求，单凭这条信息不能区分 DNS、连接超时或 TLS 等原因。安装脚本在下载前已经检查过识别程序能启动；此时可以直接上传本机已有的完整模型，无需反复运行下载命令。

在 **Windows 电脑的 PowerShell** 中运行下面命令，将 `服务器公网IP` 替换为日语网站服务器的地址：

```powershell
scp "C:\LanguageMaster\data\speech\ggml-small.bin" admin@服务器公网IP:/tmp/ggml-small.bin
```

也可用已有远程连接工具的文件上传功能，把同一个文件传到服务器 `/tmp/ggml-small.bin`。上传完成后，按下一节校验并安装；不要在服务器终端输入 Windows 文件路径。

### 上传电脑上已有的模型

电脑 PowerShell 中查看文件及校验值：

```powershell
Get-Item C:\LanguageMaster\data\speech\ggml-small.bin | Select-Object FullName, Length
Get-FileHash C:\LanguageMaster\data\speech\ggml-small.bin -Algorithm SHA256
```

把这个文件上传到服务器 `/tmp/ggml-small.bin`。只需要模型文件，不要上传 Windows 程序或整个 `data` 目录。然后在服务器执行：

```bash
(
set -e
cd /opt/nihongo
model_sha256=替换为电脑显示的64位SHA256
printf '%s  /tmp/ggml-small.bin\n' "$model_sha256" | sha256sum -c -
sudo docker compose -p nihongo-web -f compose.yaml exec -T app \
  mkdir -p /app/data/speech
sudo install -T -m 644 /tmp/ggml-small.bin server-data/speech/ggml-small.bin
sudo docker compose -p nihongo-web -f compose.yaml exec -T app \
  node scripts/setup-speech-linux.mjs --sha256 "$model_sha256"
)
```

命令针对默认模型路径；若诊断显示自定义 `WHISPER_MODEL`，应按对应挂载位置安装。先校验上传文件，再由应用用户创建模型目录，以便安装脚本能写入安装信息。安装脚本检查程序能启动、模型大小及 SHA-256，不会运行真实转写；已有模型并传入 `--sha256` 时不访问下载源。校验不符时停止，先核对上传是否完整。

### 在服务器下载缺失的模型

```bash
cd /opt/nihongo
sudo docker compose -p nihongo-web -f compose.yaml exec -T app \
  node scripts/setup-speech-linux.mjs --download-model
```

这条命令明确允许下载缺失的多语言 small 模型，并检查官方提供的 SHA-256。下载约 0.5 GB，耗时取决于服务器网络；无法访问下载源时使用上面的上传方式。已有损坏文件时，脚本不会覆盖它；核实损坏后，用完整文件重新上传替换。不要改用只支持英语的 `small.en`。

模型位于持久化数据目录，准备完成后即可重新识别，无需为补模型重建镜像或重启应用。

## 3. 验证录音识别

1. 重新运行第 1 步诊断，确认程序能启动、模型可读。
2. 打开原来的 HTTPS 网站，在学习设置中点“重新检查语音状态”，然后返回录音练习。
3. 录制一段短日语，例如“こんにちは。よろしくお願いします。”，结束后确认出现可编辑的日语文字。
4. 若仍失败，保留具体错误：模型加载失败、程序启动失败、超时或无声音对应不同问题。诊断成功和麦克风测试通过都不能替代这次识别验收。

Windows 本机版可在项目目录执行 `npm.cmd run check:speech`。缺少本机组件时运行 `npm.cmd run setup:speech`，再重新检查。上述仓库检查和操作说明不代表已在服务器执行修复。
