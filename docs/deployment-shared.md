# 已有网站：共存部署

本文件保留作备选方案。用户现已另购 **8.133.242.232**，本次请按 [独立服务器部署](deployment.md) 执行，旧服务器上的网站继续保留。

**先查看现有服务器配置，不重装系统、不购买第二台。**

已经确认 `118.178.178.123` 是你的服务器，而且已有其他网站。目标网址准备为 `https://jp.nbblearnjp.xyz`，先保留原有 `nbblearnjp.xyz` 网站与解析记录。下列文件是准备好的部署方案；现有系统、面板和剩余资源仍需核对。

## 1. 查看现有环境（约 2 分钟）

在阿里云控制台记下系统、CPU、内存；如果使用宝塔或 1Panel，也记下面板名称。服务器终端以下命令只读取状态，不会更改旧站：

```bash
cat /etc/os-release
free -h
df -h /
sudo ss -ltnp '( sport = :80 or sport = :443 or sport = :14317 )'
```

2 核 4 GB 是新服务器的起步建议。已有网站的负载也会占资源，不能只按总内存判断能否共用。先把网页和文字对话部署好，再测短录音。内存或 CPU 不够时再决定升级实例或另购；不用为了 DeepSeek / MiniMax API 买 GPU。

## 2. 上传到独立目录（约 5–10 分钟）

在电脑项目目录运行 `npm.cmd run package:web`，把 `releases/nihongo-web.tar.gz` 上传到服务器 `/tmp/nihongo-web.tar.gz`。

```bash
sudo mkdir -p /opt/nihongo
sudo tar -xzf /tmp/nihongo-web.tar.gz -C /opt/nihongo
cd /opt/nihongo
```

已有 Docker 和 Compose 就继续使用，先运行 `sudo docker compose version` 验证。安装助手 `deploy/install-docker-ubuntu.sh` 只适用于 Ubuntu 24.04；其他系统或已经由面板管理的容器环境，按对应官方安装方法准备，不要直接替换 Docker，也不要卸载面板依赖。

```bash
sudo node deploy/configure.mjs --shared
sudo docker compose -f compose.shared.yaml up -d --build
sudo docker compose -f compose.shared.yaml ps
```

域名填 `jp.nbblearnjp.xyz`，设置自己的网页登录密码，并从阿里云备案控制台复制真实备案号。配置助手需要宿主机 Node 18 或更新版本；应用本身使用容器中的 Node 24。

**本模式只发布 `127.0.0.1:14317`，不占用服务器的 80/443。** 应用的 4317 端口不对外发布。不要给 14317 或 4317 添加公网防火墙放行规则。不要同时运行 `compose.yaml` 和 `compose.shared.yaml`；它们是两个替代部署方案。

首次构建需要下载镜像和依赖。大陆网络访问 Docker Hub、GitHub 的情况需实际检查；失败时保留错误，不要删除或重装现有网站。

## 3. 新增日语站点与 HTTPS（操作约 10 分钟，证书签发另计）

阿里云 DNS → `nbblearnjp.xyz` → 新增 A 记录：

| 字段 | 填写 |
| --- | --- |
| 主机记录 | jp |
| 记录值 | 118.178.178.123（确认仍是这台服务器的公网 IP） |
| TTL | 600 秒或控制台默认 |

保留原来的 `@` 根域名记录。若 `jp` 已存在，先检查现有用途与冲突。填写方式见[阿里云 DNS 官方说明](https://help.aliyun.com/zh/dns/pubz-add-parsing-record)。

在**现有网站服务或面板**中新增一个专用站点，按下面配置；不要改动旧站点：

| 配置 | 值 |
| --- | --- |
| 域名 | jp.nbblearnjp.xyz |
| HTTPS | 用现有面板或证书工具给这个域名签发证书，启用 HTTP 跳转 HTTPS |
| 反向代理目标 | http://127.0.0.1:14317（仅适用于网站网关运行在宿主机的情况） |
| 发往上游的 Host | jp.nbblearnjp.xyz（Nginx 中可使用 `$host`） |
| 超时 / 请求大小 | 150 秒 / 16 MiB |

Nginx 示例在 `deploy/nginx-site.conf.example`；证书路径是占位符，填入真实路径后才能验证配置。用 `nginx -t` 检查通过再重载；不要覆盖整个 Nginx 配置。Host 的传递方式见 [Nginx 官方 proxy_set_header 文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)。

**1Panel / Docker 网关注意：** 如果已有 Nginx / OpenResty 本身运行在容器里，它的 `127.0.0.1` 指向该容器，不是宿主机。此时要按实际容器网络，把网关与本应用 Caddy 接入受控的共同 Docker 网络并代理内部服务名；不要通过把 14317 绑定公网解决。需要先确认现有面板、网络和网关容器名才能落具体配置。

流量路径：浏览器 HTTPS → 原有网关的新虚拟站点 → 私有 Caddy 登录保护 → 日语应用。TLS 在原有网关终止，内部 HTTP 只用于本机/受控容器网络；必须从 HTTPS 域名登录和使用麦克风。

## 4. 上传语音模型（操作约 5 分钟，上传另计）

把电脑的 `data/speech/ggml-small.bin` 上传到服务器 `/tmp/ggml-small.bin`，只上传模型文件。

```bash
cd /opt/nihongo
sudo install -m 644 /tmp/ggml-small.bin ./server-data/speech/ggml-small.bin
sudo docker compose -f compose.shared.yaml exec app node scripts/setup-speech-linux.mjs
```

没有模型时可在最后的命令追加 `--download-model` 明确允许从官方源下载。仅验证已有模型时不下载。短句录音经 HTTPS 上传到自己的服务器，练习录音保留 90 天，识别临时文件处理后删除。

## 5. 迁移与验证（约 10 分钟）

1. 打开 `https://jp.nbblearnjp.xyz`，应先出现网页登录提示；原有网站应仍可访问。
2. 原电脑应用导出学习记录，在新网站设置中恢复；有服务器记录时先备份，恢复会替换它们。
3. 在网站设置重新填 DeepSeek / MiniMax 密钥，测试文字对话与试听；JSON 备份不带密钥。
4. 录 5–10 秒日语，确认转写，再发送；检查服务器实际识别耗时与旧站负载。
5. 刷新、重启后确认记录保留；无痕窗口未登录不能读学习数据；公网不应能访问 14317 / 4317。

之后所有维护命令都加 `-f compose.shared.yaml`，例如：

```bash
sudo docker compose -f compose.shared.yaml logs --tail=60 app caddy
sudo docker compose -f compose.shared.yaml stop
sudo docker compose -f compose.shared.yaml start
```

备份、更新与故障说明也可参考[独立部署文档的维护部分](deployment.md#日常维护需要时展开查阅)，将 Compose 命令换成本文件形式。两套配置共用同一数据目录，不能一起启动。此版本供你个人使用，登录设备共享一份学习记录，没有多人独立数据。
