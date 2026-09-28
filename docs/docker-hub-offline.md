# Docker Hub 超时：导入已准备的官方镜像

当前服务器 `8.133.242.232` 已安装 Docker。拉取 `caddy:2.11.4-alpine` 时访问 `registry-1.docker.io:443` 超时；这次失败发生在下载镜像，网站配置还没有保存。无需重新安装 Docker，也不用反复输入密码。

阿里云官方说明，旧镜像加速器已停止同步最新镜像；因此本次使用本机从官方源获取的镜像包，不依赖未经核实的公共镜像源。参见[阿里云镜像加速说明](https://help.aliyun.com/zh/acr/user-guide/accelerate-the-pulls-of-docker-official-images)。

## 现在做这三步

1. 在 Workbench 的文件管理中进入 `/tmp`，上传电脑上的 `C:\LanguageMaster\releases\nihongo-offline-install.tar.gz`，约 540 MB。
2. 上传完成后，在服务器终端运行：

   ```bash
   sudo tar -xzf /tmp/nihongo-offline-install.tar.gz -C /opt/nihongo
   cd /opt/nihongo
   sudo bash deploy/import-offline-images.sh
   ```

3. 看到 `Images imported` 后，运行配置助手：

   ```bash
   sudo node deploy/configure.mjs
   ```

域名保持 `jp.nbblearnjp.xyz`；设置自己的网页登录密码，填写真实 ICP 备案号。此时 Caddy 已在服务器上，助手会使用本地镜像，不再下载它。原有 `.env` 与学习数据不会包含在安装包里；已有配置时，助手仍会询问是否保留。

## 包含什么

| 官方镜像 | 用途 |
| --- | --- |
| caddy:2.11.4-alpine | 登录、HTTPS 和密码哈希 |
| debian:bookworm-slim | 编译语音识别程序 |
| node:24-bookworm | 编译应用与 Linux 依赖 |
| node:24-bookworm-slim | 运行应用 |

镜像固定为 **Linux / amd64**，适用于这台服务器。使用官方 google/go-containerregistry 的 crane 工具获取，核对官方清单、配置及层摘要；每个文件另带 SHA-256 校验。服务器导入脚本先核对全部文件，再执行 [docker image load](https://docs.docker.com/reference/cli/docker/image/load/) 并检查平台和 Caddy 启动。

安装包还包含当前应用源码、修复后的配置助手和导入脚本，不含个人数据库、API 密钥、`.env` 或语音模型。它解决 Docker Hub 获取镜像的问题；**应用仍需在服务器构建，APT、npm 与 whisper.cpp 源码获取仍需要网络**。没有把基础镜像包称为已构建好的应用镜像。

## 后续启动

配置、DNS 与防火墙准备好后，独立服务器使用：

```bash
cd /opt/nihongo
sudo docker compose up -d --build --pull never
```

`--pull never` 禁止 Compose 再次拉取运行镜像；Dockerfile 使用引擎自带的解析前端，避免额外从 Docker Hub 拉前端镜像。基础镜像已导入；构建中的依赖下载仍要检查实际网络结果。真实服务器尚需确认导入、构建、HTTPS 和录音，不能把本机包校验当作这些步骤已完成。

更新离线总包时，在电脑项目目录运行 `npm.cmd run package:offline`。普通的 `npm.cmd run package:web` 仍只输出小的源码包，不包含大型镜像。
