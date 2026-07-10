# Security Policy

## Supported use

TableShot 只支持单用户、本机 loopback 使用。服务会拒绝绑定非 loopback 地址；不要通过端口转发、反向代理或容器端口映射将它暴露到其他主机。

请使用最小权限 MySQL 账号，只授予目标 schema 所需的读取权限。不要使用 `root`，不要授予 `FILE`、DDL 或 DML 权限。需要连接远程 MySQL 时，配置 `MYSQL_SSL_CA_PATH` 并保持 `MYSQL_SSL_REJECT_UNAUTHORIZED=true`。

`ANALYZE TABLE` 是可选副作用，只应在理解锁、IO 和权限影响后显式启用。

## Sensitive data

以下文件可能包含数据库结构、查询结果、SQL、错误栈或业务数据：

- `captures/`
- `logs/`
- `tmp/`
- `.env`
- MySQL TLS 私钥或 CA 文件

这些路径不应提交、上传到 issue 或发送给无权访问业务数据的人。提交复现材料前请脱敏。

静态前端只从启动时校验的固定资产白名单加载到内存；`captures/` 不通过 HTTP 提供。失败日志、PNG 与诊断 HTML 采用受限预算，新建敏感文件在类 Unix 系统上使用仅所有者可读写权限。

## Local threat model

TableShot 不把同一操作系统账号下的其他进程视为隔离边界。拥有仓库写权限的进程本来就能读取、替换或删除本地业务产物；不要在同一账号下同时运行不受信任的程序。实现会拒绝稳定的符号链接/目录越界，并通过文件句柄、身份复验和内存静态资产消除正常运行中的路径切换窗口，但纯 Node.js 不提供跨平台 `openat`/`unlinkat`，不承诺抵御同权限进程持续反复切换目录节点。

## Reporting a vulnerability

请通过仓库维护者提供的私下渠道报告，不要先创建包含可利用细节、真实凭据或业务数据的公开 issue。报告应包括影响范围、最小复现、运行环境和建议修复方向。

确认和修复前，请勿公开可直接利用的 PoC。
