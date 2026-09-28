# 阿里云部署：个人日语学习网站

先打开项目根目录的 `deployment-guide.html`，一次完成一张卡。本文件用于复制命令和排查。

当前选择：为现有服务器启用 **IP HTTPS 入口**，目标为 **https://8.133.242.232**。上海服务器已升级并完成构建，app healthy、Caddy 运行。**下一步仅上传并执行 `enable-ip-https.mjs`；尚未在服务器执行、尚未确认 IP 证书签发或其他设备访问，不代表网址已经可用。** 继续使用现有网站登录密码和学习记录；旧服务器 `118.178.178.123` 保留。域名入口的备案排查折叠为后续参考。

**升级步骤已完成，不需要重复操作。** 先前建议 2 核 / 4 GB，是因为当前 small 语音模型官方标注内存约 852 MB，还需要容纳操作系统和网站进程；4 GB 是本应用的余量建议，实际识别速度仍需测量。依据：[whisper.cpp 内存说明](https://github.com/ggml-org/whisper.cpp#memory-usage)。

以后需要升配时再参考[官方升配步骤](https://help.aliyun.com/zh/simple-application-server/user-guide/upgrade-a-simple-application-server)。本次从服务器恢复“运行中”后继续安装即可。

连接入口：**远程连接 → Workbench 一键连接 → 立即登录**。可先在终端运行 `free -h` 和 `df -h /` 检查实际内存与空间；这两条命令只读取状态。见[官方连接步骤](https://help.aliyun.com/zh/simple-application-server/user-guide/connect-to-linux-server-remotely)。

部署后：浏览器 → HTTPS + 网站密码 → 日语应用 → SQLite / 语音识别。DeepSeek 与 MiniMax 仍用各自的云端 API。个人学习记录在服务器，所有登录设备共享同一份记录；本版没有多人独立账号。

## 1. 确认新服务器资源（约 5–10 分钟）

阿里云控制台进入「轻量应用服务器 → 华东 2（上海）→ Ubuntu-gxzp」。操作前确认公网 IP 为 `8.133.242.232`，避免选到承载原网站的旧服务器。

以后选购可参考如下配置；本次已购买，只需核对升配后的资源。这是结合本应用负载的起步配置，不是性能承诺：

| 配置 | 选择 |
| --- | --- |
| 产品 | 轻量应用服务器，通用型，1 台 |
| 地域 | 中国大陆，选离你近的地域；不确定可选杭州 |
| CPU / 内存 | 2 vCPU / 4 GB 起；经常录音可考虑 4 vCPU / 8 GB |
| 镜像 | 系统镜像 → Ubuntu 24.04 LTS，x86_64 |
| 磁盘 / 网络 | 本次按 4 GB 套餐的系统盘配置即可，带公网 IPv4；核对套餐流量、带宽和超额费用 |

无需购买 GPU、独立数据库或负载均衡。DeepSeek、MiniMax 费用另按各自账户计算。2 核 4 GB 的 whisper small 识别耗时需要在服务器实测；优先录 5–10 秒短句。

套餐和镜像随地域变化，结算前同时看首期与续费金额；不依赖过期促销价格。操作见[阿里云创建服务器说明](https://help.aliyun.com/zh/simple-application-server/user-guide/create-a-server)。

如果核实已有阿里云网站备案，仅在阿里云内部增加或更换非经营性网站服务器、且不涉及特定 IP 变更要求时，通常无需重新备案。当前网站 ICP 状态仍待核实，域名实名认证本身不能确认网站备案状态。网站名称、内容等备案信息有变化时，先在备案控制台核对相应变更流程。见[阿里云变更备案说明](https://help.aliyun.com/zh/icp-filing/basic-icp-service/support/changes-for-the-record-the-faq)。

**现有服务器上有网站时，不要重装系统，也不要停止原网站。** 本方案的独立 Caddy 网关要占用 80/443；已有 Nginx、宝塔或其他网关时，需要先调整为共存部署。选子域名只解决域名冲突，不解决端口冲突。

## 2. 上传部署包并配置（操作约 10 分钟，下载另计）

此步已完成。用户终端截图已确认官方镜像导入成功、Caddy 2.11.4 可运行，配置助手已保存网站配置。直接进入第 3 步；以下安装说明和 [Docker Hub 超时处理](docker-hub-offline.md) 保留作重新部署参考。

在电脑项目目录打包：

```powershell
npm.cmd run package:web
```

生成 `releases/nihongo-web.tar.gz`，只包含应用代码和部署文件，不带个人数据库、密钥、模型或 Windows 的 node_modules。

在服务器控制台点「远程连接 → Workbench」。以下独立部署命令用于一台可使用 80/443 的 Ubuntu 24.04 服务器。先检查端口：

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
```

如果列出了现有服务，先确认共存方案，不执行启动命令。不要直接杀进程。

部署包已在电脑生成：`C:\LanguageMaster\releases\nihongo-web.tar.gz`。在 Workbench 左侧点 **文件管理 → 进入 /tmp → 上传文件**，选择这个包，等待上传达到 100%。Workbench 一键连接的 admin 用户可向 `/tmp` 上传，无需为了这一步改用 root 登录。参见[阿里云文件上传说明](https://help.aliyun.com/zh/simple-application-server/user-guide/use-workbench-to-transfer-files-to-a-linux-server)。若界面没有上传入口，可用 SCP/SFTP 上传，SSH 用户名取控制台显示值。下面只在 Linux 服务器终端执行：

```bash
sudo mkdir -p /opt/nihongo
sudo tar -xzf /tmp/nihongo-web.tar.gz -C /opt/nihongo
cd /opt/nihongo
sudo bash deploy/install-docker-ubuntu.sh
sudo node deploy/configure.mjs
```

配置时域名默认 `jp.nbblearnjp.xyz`，设置自己的登录名与至少 12 字符的网站密码，并填写真实的 ICP 备案号。网站密码不同于阿里云密码、DeepSeek / MiniMax 密钥。密码以星号输入，不进入命令历史；后端只存其 bcrypt 哈希。

配置保存在服务器项目根目录 `.env`。这是私密文件，不上传聊天、不加入源码包。安装脚本只用于 Ubuntu 24.04，依照 [Docker 官方 Ubuntu 安装步骤](https://docs.docker.com/engine/install/ubuntu/)；检测到已有容器环境时不会自动卸载替换。

## 3. 绑定域名并开放端口（约 5 分钟，解析生效另计）

当前解析已验证：`jp.nbblearnjp.xyz` 的 A 记录为 `8.133.242.232`，未查到该主机名的 AAAA 记录。无需再次添加解析；现在核对新服务器防火墙的 80 / 443 规则，之后执行第 4 步启动命令。以下 DNS 表保留作参考。

推荐先用 **https://jp.nbblearnjp.xyz**，保留根域名现有记录。

阿里云控制台 → 云解析 DNS → 公网权威解析 → `nbblearnjp.xyz` → 添加记录：

| 字段 | 填写 |
| --- | --- |
| 记录类型 | A |
| 主机记录 | jp |
| 记录值 | 8.133.242.232（如服务器公网 IP 变化，以实例详情为准） |
| 线路 / TTL | 默认 / 600 秒（或控制台默认） |

记录值只填 IP，不填 https、端口或路径。若 `jp` 已有记录，先核对用途与冲突；不要盲目新增重复记录。此配置暂不使用 IPv6，不要把该主机名的 AAAA 记录指向另一台机器。参见[阿里云添加解析记录](https://help.aliyun.com/zh/dns/pubz-add-parsing-record)。

在这台轻量服务器的「防火墙」核对入站 TCP 80、443 已启用、来源为 `0.0.0.0/0`；阿里云 Linux 轻量服务器默认已有这些规则，缺少时才添加，不重复创建。22 仅按你需要的 SSH / Workbench 访问范围配置。不要开放应用端口 4317，也不要开放数据库端口。若已有系统防火墙，也需允许 80/443。见[官方防火墙说明](https://help.aliyun.com/zh/simple-application-server/user-guide/manage-the-firewall-of-a-server)。

在 Windows PowerShell 检查：

```powershell
Resolve-DnsName jp.nbblearnjp.xyz -Type A
```

返回的 IP 应与这次服务器一致；DNS 缓存可能导致稍后才生效。

## 4. 启动 HTTPS，准备录音识别（操作约 10 分钟，构建另计）

### 当前下一步：启用 IP HTTPS 入口

1. 在 Workbench 左侧文件管理打开 `/tmp`，上传电脑上的 `C:\LanguageMaster\releases\enable-ip-https.mjs`。
2. 在服务器终端执行：

   ```bash
   sudo node /tmp/enable-ip-https.mjs
   ```

执行后提供最后的结果，再验证 **https://8.133.242.232** 的证书、登录和其他设备访问。助手使用已有镜像，备份并修改入口配置，保留现有密码和学习数据。服务器执行、证书签发与公网可用性目前均待验证。

<details>
<summary>备选：以后使用域名时核查 ICP 备案</summary>

原域名入口的排查记录：

用户已执行修复助手并确认 app healthy、Caddy 运行，80 / 443 已由 Caddy 发布。随后开发机公网实测：HTTP 返回 `403`、`Server: Beaver`，正文标题为 `Non-compliance ICP Filing`，指向阿里云 `beian-block` 页面；HTTPS 握手连接被重置。该结果确认当前访问受到备案系统拦截，不说明具体原因。最新用户截图只显示域名控制台「实名认证成功」。具体网站 ICP 状态待重新核实，不能据此认定已经备案或没有备案。

按[阿里云变更备案FAQ](https://help.aliyun.com/zh/icp-filing/basic-icp-service/support/changes-for-the-record-the-faq)，已备案、保留旧服务器并增加阿里云服务器用于域名解析，通常无需重新或变更备案。当前先点击页面右上角「备案」（位于「费用」和「工单」之间），或直接打开独立 ICP 控制台的[「我的备案」](https://beian.aliyun.com/pcContainer/myorder)，核对 `nbblearnjp.xyz` 的网站备案状态、备案号和接入服务商。找不到对应记录时，再请备案支持协助核对；不先注销或重新提交备案。

可复制给客服（未替用户发送）：

> nbblearnjp.xyz 的域名实名认证已成功，网站 ICP 备案状态及备案号仍待独立 ICP 控制台核实，旧站 118.178.178.123 保留。新增子域名 jp.nbblearnjp.xyz 指向上海轻量服务器 8.133.242.232。应用健康检查已通过，Caddy 已启动。但公网 HTTP 返回 403，页面标题 Non-compliance ICP Filing，拦截页 ID：00000000005129461927；HTTPS 握手连接被重置。请协助核查此域名是否有对应的网站 ICP 备案记录及备案号、阿里云接入状态、新服务器上的备案识别与拦截原因。

客服处理后再检查 HTTPS、登录及语音/AI 配置。没有依据保证等待固定小时数会自动恢复。官方参考：[备案阻断排查](https://help.aliyun.com/zh/icp-filing/basic-icp-service/web-site-for-the-record-to-block-1)、[官方售后入口](https://help.aliyun.com/zh/document_detail/464625.html)。

</details>

### 已完成：健康检查修复（历史参考）

最新用户输出已确认应用与语音组件构建完成，镜像 `nihongo-web:local` 已创建。应用容器运行，但健康检查仍为 `starting`，Caddy 停在 `Created`。已在本机复现原因：Node 24 的 `fetch` 没有传入指定的 Host，检查请求被应用的域名校验返回 403。已将两份 Compose 的探针改为 `node:http.get`，保留原有 Host、Origin 和代理令牌校验。

该修复已执行成功，以下操作保留作参考：

1. 上传电脑上的 `C:\LanguageMaster\releases\fix-healthcheck.mjs` 到 Workbench 的 `/tmp`。
2. 在服务器执行（等待健康检查约 30–120 秒）：

   ```bash
   sudo node /tmp/fix-healthcheck.mjs
   ```

助手先确认应用镜像存在、配置可解析，仅备份并替换已知的错误探针；如旧部署任务仍在等待，先结束该等待任务。随后以 `--no-build --pull never` 使用原镜像重新创建容器，等待健康检查通过，显示容器状态。它不修改 `.env`、密码、数据库或模型。若现有探针不符合预期，会停止而不自动覆盖自定义配置。成功后需实际打开 `https://jp.nbblearnjp.xyz` 确认 TLS 和登录；本机回归测试不代表服务器修复已执行。

### 历史参考：后台构建与日志

此前 `nihongo-deploy.service` 成功启动，最终镜像构建也已成功，健康检查修复也已完成。以下保留后台启动操作与日志检查供以后重新构建使用；本次先核查备案拦截。

用户截图已确认进入首次构建，约 703 秒时仍在 APT 下载阶段，尚不能认定网站启动成功。`up -d` 中的 `-d` 用于启动后的容器后台运行；首次构建仍由当前命令执行。关闭 Workbench 可能中断前台任务。

2026-09-28 用户检查结果：`docker compose ps -a` 只有表头，`journalctl -u nihongo-deploy` 为 `No entries`。没有网站容器，且没有可用后台日志；不能据此断言上次是否执行过后台命令。当前已回到终端提示符，直接交给服务器系统服务后台执行（约 1 分钟操作，不含构建时间）。本次把构建输出另存到文件：

```bash
sudo systemd-run --unit=nihongo-deploy --collect --service-type=exec --working-directory=/opt/nihongo --property=StandardOutput=append:/opt/nihongo/deploy-build.log --property=StandardError=inherit --property=UMask=0077 /usr/bin/docker compose --progress plain up -d --build --pull never
```

看到 `Running as unit: nihongo-deploy.service` 表示后台任务已启动，此后关闭自己的电脑不会中断该任务；阿里云服务器仍需保持运行。该提示并不代表构建成功，Compose 输出和错误会追加到 `/opt/nihongo/deploy-build.log`；journal 只用于辅助查看 systemd 生命周期事件。已完成的构建缓存与配置保留，未完成的构建步骤可能重做。若提示同名任务已存在，先运行 `sudo systemctl status nihongo-deploy --no-pager` 检查，不停止它或并行构建。Ubuntu 24.04 支持这些参数，见 [systemd-run 官方手册](https://manpages.ubuntu.com/manpages/noble/man1/systemd-run.1.html)及[文件输出配置](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd.exec.xml)；当前开发机未执行服务器后台任务。

下次重新连接 Workbench 后：

```bash
sudo tail -n 60 /opt/nihongo/deploy-build.log
cd /opt/nihongo
sudo docker compose ps -a
```

该临时构建任务不跨服务器重启自动恢复；这里只是让个人电脑可以关机。后台任务运行时不要再执行下面的前台构建命令。

### 保持终端连接，正常构建

服务器终端回到部署目录后执行：

```bash
cd /opt/nihongo
sudo docker compose up -d --build --pull never
sudo docker compose ps
sudo docker compose logs --tail=60 app caddy
```

本次基础镜像已导入，`--pull never` 防止 Compose 再拉取运行镜像。首次构建仍需下载 APT、npm 依赖和 whisper.cpp 源码，并编译语音组件，耗时取决于网络。失败时保留错误提示，在源可访问后重试；不要为了下载改用不明镜像或关闭证书验证。也可以在有网络的同架构 Linux 环境构建并用 `docker save` / `docker load` 转移应用镜像。

Caddy 会为配置的域名申请和续期 HTTPS 证书，前提是 DNS 正确、80/443 可访问、证书机构可连接。见 [Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)。无需额外买证书。等 `app` 显示 healthy、Caddy 无证书错误后，打开 `https://jp.nbblearnjp.xyz`，用配置的网站密码登录。

可以先打字使用，再准备语音。电脑上已有的模型是 `data/speech/ggml-small.bin`（约 0.5 GB），只上传这一个文件到服务器的 `/tmp/ggml-small.bin`，不要上传整个 `data/`。随后执行：

```bash
cd /opt/nihongo
sudo install -m 644 /tmp/ggml-small.bin ./server-data/speech/ggml-small.bin
sudo docker compose exec app node scripts/setup-speech-linux.mjs
```

可在电脑上用 `Get-FileHash .\data\speech\ggml-small.bin -Algorithm SHA256` 查看校验值，服务器验证命令追加 `--sha256 校验值`。若没有现有模型，明确执行以下命令才从官方源下载（失败可改用上传）：

```bash
sudo docker compose exec app node scripts/setup-speech-linux.mjs --download-model
```

日语录音经 HTTPS 上传到你的服务器识别，练习录音保留 90 天，可在每课“我的录音”回听或删除；识别临时文件处理后删除；识别模型保留。系统中文/日文朗读仍用访问网页那台设备的声音；MiniMax 日语朗读需要网络与语音服务额度。

## 5. 迁移学习记录并验收（约 10–15 分钟）

1. 在电脑原应用「设置 → 导出学习记录」下载 JSON 备份。
2. 在 HTTPS 网站「设置 → 恢复学习记录」选择备份。恢复会替换服务器当前记录；有新记录时先导出留存。
3. 重新在网站设置填写 DeepSeek、MiniMax 密钥并试听。学习备份不含密钥，也不含 MiniMax 音色设置或音频缓存。
4. 用 Chrome / Edge 允许麦克风：录 5–10 秒日语 → 修改转写 → 确认发送 → 听 AI 回复，记录显示的识别耗时。
5. 刷新、重启容器后确认课次、会话与复习仍在；用另一个无痕窗口确认未登录无法访问课程和 API。

未发送草稿保留在原浏览器站点存储里，不会随学习备份迁移。本机与服务器此后分别保存数据，不会自动同步。

页面底部会显示配置的真实 ICP 备案号并链接工信部查询页。配置时未填的，上线前在服务器 `.env` 补充 `ICP_NUMBER` 并重建 app 容器。不要使用示例备案号。

## 日常维护：需要时展开查阅

停止 / 恢复（保留数据和证书）：

```bash
sudo docker compose stop
sudo docker compose start
```

更新：按[版本管理说明](version-control.md)在独立源码目录构建指定版本，再在原运行目录更新应用镜像。保留 `.env`、`server-data/`、服务器的 IP HTTPS 版 `deploy/Caddyfile` 及 Docker 证书卷。不要直接上传新源码覆盖运行目录：源码包中的 Caddy 模板会覆盖已配置的 IP HTTPS。发布前备份学习记录；不要执行 `docker compose down -v`，它会删除证书卷。目前 Git 推送不会自动发布。

记录备份推荐用网站导出；如果要完整备份含密钥的数据库、音频缓存和模型，先 `sudo docker compose stop app`，备份 `server-data/` 与 `.env`，再 `sudo docker compose start app`。SQLite 使用 WAL；不要只复制运行中的 `nihongo.sqlite` 文件。完整备份包含服务密钥，必须私密保存。

密码修改：`sudo node deploy/configure.mjs`，确认 UPDATE，输入原域名、新密码，之后 `sudo docker compose up -d`。保持原域名即可保留学习记录；切勿在旧配置尚未启动完成时只重启一部分容器，代理和应用共享令牌必须匹配。

| 现象 | 先检查 |
| --- | --- |
| 无法打开 / 证书错误 | A/AAAA 是否正确、80/443 是否可达、Caddy 日志；不要用 HTTP 页面测试麦克风 |
| 登录后显示 403 | `.env` 域名、APP_PUBLIC_ORIGIN 与代理令牌是否一致；用配置的精确域名访问 |
| 502 / unhealthy | `sudo docker compose logs --tail=60 app`，检查数据目录权限与启动错误 |
| 无法识别 | 在 app 容器执行模型检查命令；确认 HTTPS、麦克风授权、非静音短录音 |
| AI / 朗读失败 | 网站设置中的对应密钥、账户额度、服务器出站网络；本地课程不依赖 AI |

发布包不等于已上线。本机自动测试不会消耗 AI 额度；真实服务器构建、证书签发、实际录音与真实 AI 调用需在服务器就绪后验收。
