# 版本管理与迭代

仓库：<https://github.com/MAXGUAN-Game/minnanonihongo_helper>

日常从 `main` 创建修改分支，修改、测试、提交，再合并回 `main`。每个确定上线的版本打一个标签，例如 `v1.0.1`，方便找回对应代码。版本标签与代码提交不是学习数据备份。

## 每次迭代

1. 拉取最新代码，为本次修改创建分支。
2. 完成修改，运行相关测试和 `npm.cmd run build`。
3. 提交清楚说明行为变化的 commit，推送到仓库。
4. 合并稳定修改；按发布顺序更新版本号并打标签。
5. 单独更新服务器，验证登录、课程、对话及学习记录。

Windows 示例（把分支名换成本次功能名称）：

```powershell
git switch main
git pull --ff-only
git switch -c feat/lesson-practice
npm.cmd test
npm.cmd run build
git status --short
git add src tests docs
git diff --cached --stat
git commit -m "feat: improve lesson practice"
git push -u origin feat/lesson-practice
```

推送到 GitHub 不会自动更新阿里云网站。目前没有启用自动部署。

## 哪些文件进入仓库

| 保存到 Git | 仅留在本机或服务器 |
| --- | --- |
| 页面、课程内容、服务端代码、测试、部署脚本、说明文档 | `.env`、API 密钥、网站登录配置 |
| `package.json` 和锁文件、无密钥的 `.env.example` | `data/`、`server-data/`、学习备份、语音模型 |
| 原始部署模板 | `.ip-https-backups/`、部署备份、日志、下载素材、安装包 |

`.gitignore` 已排除这些私有内容。提交前仍需检查暂存差异；不要使用 `git add -f` 强行加入被忽略的数据。不要把访问令牌写入远程仓库 URL。

`releases/` 仅保留两个可直接上传的修复助手源码，供新克隆的项目继续使用；大型源码包、离线镜像包和下载内容仍不进入 Git。

## 阿里云更新与回滚

现有运行目录是 **`/opt/nihongo`**，部署目标是 **`8.133.242.232`**。保留它的 `.env`、`server-data/`、IP HTTPS 版 `deploy/Caddyfile` 和 Docker 证书卷。旧服务器 `118.178.178.123` 不参与发布。

IP HTTPS 助手会修改服务器的 `deploy/Caddyfile`。仓库保存的是原始模板，因此不要把仓库直接覆盖到运行目录，也不要在运行目录执行 `git reset --hard` 或 `git clean`。

后续发布采用独立的源码目录，例如 `/opt/nihongo-src`：

1. 在源码目录取指定标签或提交，构建带提交编号的新镜像。
2. 为当前正在运行的镜像保留回滚标签；按本次数据库变化准备数据备份。
3. 在原 `/opt/nihongo` 切换应用镜像，只更新 `app`，保留网关和持久化目录。
4. 验证成功后记录上线的提交编号；失败则使用保留的旧镜像恢复。

服务器已创建 `/opt/nihongo-src`，并已通过终端输出确认 v1.1.0 运行正常。v1.1.1 的具体构建、备份、切换与回退命令见 [本次更新说明](v1.1.1-release.md)；Git 推送完成后仍需单独执行服务器更新。

不要在新克隆目录直接执行 `docker compose up`：Compose 项目名相同，但相对路径 `./server-data` 会指向新目录。数据库结构发生变化时，单纯回滚代码可能不够；先停应用，完整备份 SQLite 所在目录及配置，再处理数据兼容性。

## 初始版本

`v1.0.0` 用于记录当前已有的本机/服务器版应用基线。云端实际使用哪个提交，仍需由之后的发布记录确认；标签本身不证明服务器已经更新。
