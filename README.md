# TableShot

TableShot 是一个仅在本机 loopback 上运行的 MySQL 查询与截图工作台。它用于浏览有权限访问的库表、执行五种服务端固定模板、预览结果，并通过本机 Edge/Chrome 将结果保存为 PNG 留档。

## 安全边界

- HTTP 服务只允许绑定数值 loopback 地址 `127.0.0.1` 或 `::1`，不接受可被 DNS/hosts 重定向的 `localhost`，也不能开放到局域网或公网。
- 浏览器不能提交 SQL。前端只提交 `templateId`、目标库表和经过选择的字段；SQL 由服务端模板注册表生成并通过 prepared statement 执行。
- 请使用最小权限 MySQL 账号。不要使用 `root` 或带有 `FILE`、DDL、DML 权限的账号。
- “刷新存储统计”会执行 `ANALYZE TABLE`，不是纯只读操作；界面默认不执行，必须由用户显式确认。
- 截图、失败日志和临时报告可能包含业务数据，均保存在本机仓库目录下，不应提交到 Git。

## 功能

- 连接本机或可访问的 MySQL，并可选启用 CA 校验的 MySQL TLS
- 浏览数据库、表、字段结构和受限数据预览（最多 100 行、64 列；长文本和二进制摘要会在界面明示）
- 服务端生成并执行五种固定模板：
  - 查询时间范围
  - 查询区域分布（最多返回 500 行；每个文本值最多 512 字符，并明确标记截断）
  - 查询总行数
  - 查询表结构
  - 查询存储空间
- 手动指定时间字段或区域字段；服务端会再次验证字段确实属于目标表
- 单表查询、单表截图和最多 6 worker 的批量截图
- 唯一 `runId` 隔离每次运行，防止覆盖历史图片
- 截图会话预热、复用、超时、容量限制和空闲回收
- 可复制由服务端返回的规范 SQL
- 失败日志、内部诊断 HTML、显式结果截断提示

## 运行要求

- Node.js 22 或 24
- 可访问的 MySQL 服务
- Microsoft Edge、Google Chrome 或 Chromium

安装并启动：

```bash
npm install
npm start
```

启动脚本会自动读取存在的 `.env`：

```bash
copy .env.example .env
npm start
```

默认入口：

- 登录页：`http://127.0.0.1:3811/`
- 工作台：`http://127.0.0.1:3811/app`
- 纯本地演示：`http://127.0.0.1:3811/app?preview=1`

演示模式使用页面内 fixture，所有会访问数据库、截图或打开目录的操作都会被禁用。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 只能是数值 loopback `127.0.0.1` 或 `::1`；不接受 `localhost` |
| `PORT` | `3811` | HTTP 端口 |
| `BROWSER_PATH` | 自动发现 | Edge/Chrome/Chromium 可执行文件 |
| `BROWSER_CHANNEL` | `ConfiguredBrowser` | 自定义浏览器显示名称 |
| `MYSQL_QUERY_TIMEOUT_MS` | `15000` | 查询超时，限制在 1–120 秒 |
| `MYSQL_SSL_CA_PATH` | 空 | MySQL TLS CA 文件路径；配置后启用 TLS |
| `MYSQL_SSL_REJECT_UNAUTHORIZED` | `true` | 是否校验 MySQL 服务端证书 |
| `MAX_BROWSER_SESSIONS` | `7` | 浏览器会话数；代码中还有不可突破的硬上限 |
| `CAPTURE_RETENTION_MS` | `0` | 截图保留时间；`0` 表示不自动删除 |
| `CAPTURE_TMP_RETENTION_MS` | `86400000` | 失败 HTML、浏览器临时文件保留时间 |
| `CAPTURE_CLEANUP_INTERVAL_MS` | `3600000` | 截图/临时目录清理检查间隔 |
| `LOG_RETENTION_MS` | `0` | 内部失败日志内容保留时间；正数会清空过期内容并保留受限文件槽，`0` 表示不自动清空 |

自动清理是破坏性行为，因此截图和日志默认永久保留。截图只有在显式配置 `CAPTURE_RETENTION_MS` 后才会删除；内部失败日志只有在显式配置 `LOG_RETENTION_MS` 后才会清空过期内容。清空后的内部日志槽不会跨路径删除，可由后续失败安全复用。

## 工作流

1. 使用最小权限账号连接 MySQL。
2. 选择数据库和目标表。
3. 选择试跑表，查看字段及分页预览。
4. 选择模板；前端向 `/api/query/preview` 请求服务端规范 SQL。
5. 执行查询或截图。
6. 勾选多个表生成“表 × 模板”任务，并批量运行。

存储空间模板会显示可选的统计刷新开关。未勾选时只读取现有 `information_schema` 统计；勾选后才调用带 `confirm: true` 的 `/api/analyze-table`。

## 输出

截图路径：

```text
captures/<runId>/<任务名>/<表名>/<固定图片名>.png
```

服务端返回本次运行根目录 `captures/<runId>`，前端不会自行拼接磁盘路径。相同运行内不允许覆盖同名图片，PNG 通过临时文件原子发布。截图不会通过 HTTP 暴露；请使用界面的“打开目录”查看。

- `captures/`：PNG 产物
- `logs/`：失败日志
- `tmp/capture-failures/`：截图失败时保留的内部 HTML
- `tmp/browser-profile/`：隔离的浏览器 profile

查询结果和截图行数有独立上限。界面、产物元数据和报告 HTML 会分别说明“查询结果达到上限”和“截图只包含前 N 行”。

内部失败日志受文件数、单文件和总字节预算限制；截图失败诊断 HTML 最多保留 50 个、总计最多 8 MiB。类 Unix 系统上的新日志、PNG 和诊断 HTML 使用 `0600` 权限。

## API 概览

- `GET /api/status`：连接健康状态与浏览器可用性
- `GET /api/templates`：公共模板元数据，不包含执行函数
- `POST /api/connect`：原子验证并替换 MySQL 连接池
- `GET /api/databases`
- `GET /api/tables?database=<db>`
- `GET /api/columns?database=<db>&table=<table>`
- `GET /api/preview?database=<db>&table=<table>&limit=<n>`
- `POST /api/query/preview`：生成规范 SQL，不执行模板查询
- `POST /api/query`：执行结构化模板，可选截图
- `POST /api/analyze-table`：要求 `confirm: true`
- `POST /api/capture/warmup`：受数量、格式和并发限制的预热
- `POST /api/open-folder`：只允许 `captures/`、`logs/`、`tmp/` 下的目录

旧的 `/api/automation/run` 已停用并返回 `410 Gone`。批量执行统一为前端受限 worker 调用结构化 `/api/query`。

示例查询请求：

```json
{
  "database": "analytics",
  "table": "orders",
  "templateId": "time-range",
  "fields": { "timeField": "created_at" },
  "capture": true,
  "taskName": "daily-report",
  "runId": "72a26b32-7fee-4e70-a7ef-fd95b4eb279e",
  "captureProfileKey": "single-run-preview"
}
```

请求中出现 `sql` 会被拒绝。所有 POST API 只接受 `Content-Type: application/json`。

## 开发与验证

```bash
npm run check
npm run lint
npm test
npm run verify
```

- 测试使用 Node 内置 test runner，不需要真实 MySQL 或浏览器。
- CI 在 Node 22 和 24 上执行完整 `verify`。
- 真实 MySQL/浏览器 smoke test 仍应在发布机器上使用非敏感测试库执行。

维护者请继续阅读 [MAINTAINER_GUIDE.md](./MAINTAINER_GUIDE.md)、[CONTEXT.md](./CONTEXT.md) 和 `docs/adr/`。

## 明确限制

- 单进程、单用户、本机工具，不是多用户服务。
- 数据库连接与任务队列只保存在内存中，重启或刷新后需要重新建立。
- 浏览器必须安装在运行服务的同一台机器上。
- 大表模板仍可能消耗数据库资源，因此有查询超时、结果上限和有限连接队列。
