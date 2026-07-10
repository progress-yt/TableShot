# Maintainer Guide

## 领域边界

TableShot 是单用户、本机 loopback 工具。领域词汇见根目录 `CONTEXT.md`，关键安全决策见 `docs/adr/`。

## 模块

- `server.js`：配置、HTTP 安全边界、API 编排、错误响应和生命周期。
- `lib/templates.js`：唯一模板注册表、字段识别、服务端 SQL 构造和公共模板元数据。
- `lib/mysql.js`：原子连接池替换、prepared statement、元数据访问、结果上限和健康检查。
- `lib/capture.js`：安全路径、Chromium/CDP、超时、会话容量、原子 PNG 和保留策略。
- `public/app-core.js`：可测试的请求协调、运行锁、任务 ledger、分页和请求白名单。
- `public/app.js`：工作台状态与 DOM 编排；不得重新实现 SQL 模板。
- `public/login.js`：连接表单与非敏感草稿。

## 不变量

1. HTTP 只能绑定 loopback。不得通过配置重新开放远程监听。
2. 客户端不得提交 SQL。新增查询必须进入 `TEMPLATE_REGISTRY`。
3. 带值的 MySQL 查询必须使用 `execute()` prepared statement；展示 SQL 不得被用于执行。
4. 所有输出路径必须在最终 `resolve`/`realpath` 后仍属于受控根目录。
5. 同一 `runId` 的图片不得覆盖；`folderPath` 指向 `captures/<runId>`。
6. `ANALYZE TABLE` 必须由用户显式确认，并由服务端再次验证 `confirm: true`。
7. 预览模式不得调用真实 API。
8. `public/` 只允许固定资产并在监听前加载到内存；不得重新开放 `/captures/*` 文件服务。
9. 失败日志和诊断 HTML 必须同时具有文件数、单文件和总字节预算；4xx 不写失败日志。

## 新增模板

只在 `lib/templates.js` 中新增注册项：名称、说明、字段角色、副作用、构造函数和截图选项。前端通过 `GET /api/templates` 获取元数据，通过 `POST /api/query/preview` 获取 SQL；不要在 `public/` 复制 SQL 构造逻辑。

同时补充：

- 合法字段和非法字段测试
- 客户端 `sql` 拒绝测试
- 参数必须走 prepared statement 的测试
- 结果上限与截断元数据测试
- 截图固定文件名或显示行为测试

## 错误与日志

- 4xx 可以返回经过设计的安全消息。
- 未标记为可公开的 5xx 只向客户端返回通用消息。
- 日志失败不得覆盖原始业务错误。
- 绝对路径只允许留在服务端内部错误属性或本地日志中。
- 截图和日志自动清理默认关闭；开启前需明确告知数据保留影响。日志保留策略清空内部日志内容并复用受限槽，不跨目录删除文件。

## 发布检查

```bash
npm ci
npm run verify
```

然后使用非敏感测试库手工验证：登录、模板预览、单表查询、单表截图、批量取消、可选 ANALYZE、打开运行目录和浏览器缺失错误。

发布前确认：

- `.env`、证书、截图、日志和临时 HTML 未提交
- Node 22 与 24 CI 通过
- `npm audit` 无未评估漏洞
- README 环境变量和 API 契约与实现一致
- 未添加任意 SQL 或远程监听后门
