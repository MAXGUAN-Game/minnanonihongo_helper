# 助手直接维护服务器

## Git 先行发布（2026-11-24 起强制执行）

每次发布先在独立检出目录整理并验收本次代码，提交并推送到 `origin/main`，核对远端完整提交号。发布工具会拒绝未提交、未推送、提交号不匹配的候选；原来的源码压缩包上传发布入口已经禁用。

服务器源码目录为 `/opt/nihongo-git`，生产运行目录仍为 `/opt/nihongo`。服务器检查工作副本干净后执行 `git pull --ff-only origin main`，确认 HEAD 等于已推送提交，再从该目录构建镜像。更新脚本给镜像写入 Git 提交标签，保留生产 Compose、Caddyfile、凭据及用户数据，并继续执行完整备份、SQLite/WAL 历史核对和认证验证。

```text
node scripts/remote-deploy.mjs --check
node scripts/remote-deploy.mjs --sync <完整的已推送Git提交号>
node scripts/remote-deploy.mjs --deploy <完整的已推送Git提交号>
node scripts/remote-deploy.mjs --status <返回的任务名>
```

`--sync` 只更新服务器 Git 工作副本，不构建或重启正在运行的应用；只有 `--deploy` 加上本次 `AUTH_VERIFIED`、`UPDATE_OK`、镜像提交标签和外部 HTTPS 验证，才表示发布完成。不得把源码同步成功报告成应用部署成功。服务器工作副本存在修改或远端提交变化时应停止检查，不允许 reset、clean 或强制覆盖。

首次补齐仓库使用已验收并上线的 v1.12.0 源码作为生产基线，保留线上 v1.11.4 已有语法内容和修复。本地工作区中尚未发布的其他功能继续独立保留，不混入生产提交。以下压缩包发布说明仅为历史记录，不再作为后续操作方式。


2026-11-22 已直接发布 v1.12.0（日程表）。以线上 v1.11.4 的实际源码为基线建立独立候选，核对运行容器与基线的 package.json、main.tsx、server/app.ts SHA-256 一致；保留 1.11.3/1.11.4 修复，仅加入本次日程 UI、独立服务器日程文件及版本冲突保护。未发布工作区其他功能。候选通过 9 项认证/部署/日程单测、17 项整站浏览器验收、日程鼠标与真实触摸验收、150% 字体/坐标对照、双设备同步冲突测试及真实 Edge 日程回读测试。

用户确认迁移 Edge 的 128 条安排、8 类内容和 1 份旧周记录。仅复制浏览器 Local Storage 到临时隔离配置读取指定文件页面，未打开或修改原浏览器配置。计划单独上传并以 0600 权限安装到 /opt/nihongo/server-data/weekly-schedule.json；未进入发布包。迁移前后 revision 为 3384b6008fab15360a9a7a40815dfb0bb70b4c1f31c1ad29a20a00d29b67520e，ID、名称、备注及时间均一致。线上日程以服务器为准，保存使用版本校验拒绝旧设备覆盖，未同步改动保留在当前浏览器恢复副本中。

成功任务 nihongo-update-1795349614209-211b64fa；完整备份 /opt/nihongo-backup-v1120-R0LmRV0U。构建基于原 v1.11.4 Linux 依赖和预先验收的 dist，停止 caddy/app 后备份 SQLite、WAL、配置及用户数据，核对两次学习历史摘要一致，再验证 AUTH_VERIFIED v1.12.0、SCHEDULE_VERIFIED events=128 legacyWeeks=1 和 UPDATE_OK v1.12.0 后开放访问。Compose、Caddyfile、.env 字节未变化，未改写生产网关。旧镜像保留为 nihongo-web:rollback-20261122-v1.12.0。运行镜像 sha256:78e401b2991c91b1e404b5ea6e1460e1ed4ab9254f584d04eb7485f345088f07；发布包 SHA-256 8243bd169c17f1fe2be331409e05f6f58610d6bc706861f0f1897c79ca02e027。外部 HTTPS 200、证书验证、版本 1.12.0、匿名 bootstrap/schedule 401 均通过；线上 JS/CSS SHA-256 与独立验收构建一致。清理可重建 Docker 构建缓存回收约 564 MB，保留当前镜像、回滚镜像及全部备份，剩余约 798 MB。证据：test-results/deploy-v1.12.0.json。


2026-11-15 已直接发布 v1.11.2，修复 AI 听力对话连续播放中断及按钮交互引起的页面跳动。使用已核验的 v1.11.1 存档建立独立候选，仅合入 7 个前端文件及版本、发布说明；工作区其他未发布功能与服务器变更未进入发布包。候选通过 187 项针对性测试、17 项整站浏览器验收及生产构建，真实 Edge 连续两轮完整播放六句男女对话。首次完整重建任务 `nihongo-update-1794738596497-df1cd899` 因依赖下载缓慢和磁盘余量较小，在构建阶段取消，未暂停旧服务或修改学习数据；随后基于已核验的 v1.11.1 镜像构建增量镜像，复用既有系统和依赖。

成功任务 `nihongo-update-1794738757766-2bb1d5b0`；备份 `/opt/nihongo-session-backup-ptLC4j5d`。本次 `AUTH_VERIFIED v1.11.2`、`UPDATE_OK v1.11.2`、历史摘要及 Compose、Caddyfile、`.env` 字节一致性检查均通过，原数据挂载及旧镜像保留。外部 HTTPS 200、匿名学习接口 401、TLS 证书验证通过；线上 `/assets/index-CVsV_kWV.js` 和 `/assets/index-DaenZX1g.css` 均与独立验收构建 SHA-256 一致。运行镜像 `sha256:7964ce408438d9f48716159195f5920dddc3fa2c1c28fa3019af6d9e728092ce`；发布包 SHA-256 `f5b4ac580eb71e84d76d481382b3cca17962217ad53d47ad17b02244caf19a5e`。证据：`test-results/deploy-v1.11.2.json`；候选范围：`test-results/release-v1.11.2-manifest.json`。增量包的独立 Dockerfile 依赖本机已有 `nihongo-web:v1.11.1` 镜像，未改动工作区通用 Dockerfile。

2026-10-28 已直接发布 v1.11.1，修正听力、口语模块错误共用单元平均进度的问题：两个模块分别按自身百分比计算段位，课程卡仍取两者平均值。4 个相关测试文件、70 项测试全部通过，并检查 20% 听力、80% 口语与 50% 课程的显示。成功任务 `nihongo-update-1793170804268-11110001`；备份 `/opt/nihongo-session-backup-3PJwjZAz`。本次 `AUTH_VERIFIED`、`UPDATE_OK`、历史记录与配置一致性检查均通过；外部 HTTPS 200、匿名学习接口 401，线上 `/assets/index-CishzNIp.js` 与本地验证构建一致。应用改动仅涉及两个前端进度组件，未修改数据库结构或学习记录。证据：`test-results/deploy-v1.11.1.json`。运行镜像 `sha256:9ea7568102b588b0d12ea1f37b62a71af0421630bd28a6b48aee16dc958c4277`；发布包 SHA-256 `0ef0664b17a4edcb73362bae9bd5fdcc61e11448e59b59d180fa6fe19894d478`。

2026-10-27 已完成一次性授权。用户在本机密码窗口输入服务器账号和密码，工具仅将专用公钥追加到该账号的 `authorized_keys`，保留原有内容与备份，不修改 SSH 密码登录、sudo、网站认证、HTTPS 或学习数据库。建立新的密钥连接成功后保存本机配置，密码不持久化。

目标为 `8.133.242.232`，运行目录 `/opt/nihongo`。本机配置 `~/.ssh/languagemaster-deploy.json` 和私钥 `~/.ssh/languagemaster_deploy_ed25519` 不进入仓库或部署包。密钥关闭端口转发、代理转发、X11 和交互 PTY；保留发布所需的非交互命令及文件传输。SSH 使用已有 `known_hosts` 严格校验。

用户不需要再上传文件或执行更新命令。以下命令供助手操作：

```text
node scripts/remote-deploy.mjs --check
node scripts/remote-deploy.mjs --deploy <完整的已推送Git提交号>
node scripts/remote-deploy.mjs --status <返回的 unit>
```

默认只检查线上状态。显式发布时校验本地检出目录、已推送的 Git 提交号和版本，由服务器 Git 拉取对应提交后调用 `deploy/update-session-release.sh`，以唯一 systemd 任务和日志跟踪，不覆盖生产配置或直接上传 Caddyfile。

更新脚本必须继续执行：校验数据挂载，构建镜像，暂停学习写入，完整备份远端数据及配置、保留旧镜像，在停止写入时对数据库副本核对前后历史摘要，验证应用认证，再开放访问。恢复访问后禁止恢复旧快照覆盖新进度。

发布完成须核对本次任务的 `AUTH_VERIFIED`、`UPDATE_OK`、运行镜像及版本和外部 HTTPS。任何步骤失败先检查本次任务，不能重复启动更新或恢复旧数据库。连接授权不表示授权发布仍有问题的候选音频实现。

本次连接初检：线上 v1.4.2，应用 healthy，现有 Caddy 正常。v1.4.3 词典候选音频被用户判定仍有错误停顿，未部署；Haruka 对照音频被用户确认正常，实际产品接入另行完成。

2026-10-27 已完成 Haruka 接入并直接发布 v1.4.4。成功任务 `nihongo-update-1793092973103-1d84f383`；备份 `/opt/nihongo-session-backup-RlBgJwwG`；15 张历史数据表的前后摘要一致，Compose、Caddyfile 和 `.env` 字节一致。运行镜像与 v1.4.4 标签一致；外部 HTTPS 返回 v1.4.4，匿名学习接口保持 401，实际下载的前端 JS 与本机测试构建 SHA-256 一致。证据在 `test-results/deploy-v1.4.4.json`。

首次发布尝试因源码子目录继承私有解压 umask 而不可被容器 node 用户读取，已自动回退旧代码且保留当前数据库。远程工具现仅对独立发布源码目录规范目录 755／文件 644，Dockerfile 在最终 node 用户下执行入口文件可读与服务模块加载检查，失败会在构建阶段阻止切换。不得移除此检查，也不要对运行目录或备份目录应用发布源码权限。

取消此专用访问时，只移除该账号 `authorized_keys` 中包含 `languagemaster-deploy-8.133.242.232` 的对应公钥行，保留其他密钥；不要恢复旧 authorized_keys 备份覆盖后来新增的密钥。

2026-10-28 已直接发布 v1.11.0（课程段位一致性、出题和评分恢复、参考表达实时跟读）。成功任务 `nihongo-update-1793169787866-11100001`；备份 `/opt/nihongo-session-backup-dDsY0fuO`。本次 `AUTH_VERIFIED`、`UPDATE_OK`、历史表摘要和配置字节一致性均通过；外部 HTTPS 200、匿名学习接口 401，线上 `/assets/index-BpjaJzTs.js` 与本机验证构建一致。发布前使用只读生产配置及临时数据库完成真实供应商验收，未写入真实学习记录。证据：`test-results/deploy-v1.11.0.json`。未通过验收的中间候选始终没有切换运行服务。当前版本镜像 `sha256:2d5dac7a5f428abaa91c13ed368788ba73d37cd7a9fcde2620429023812dbe04`；发布包 SHA-256 `edc5c5cd3ece2be83d8e025a757fee17341fef8867cda5a31ff876083a91f016`。
