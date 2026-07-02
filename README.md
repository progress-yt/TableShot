# MySQL 查询与截图工具

一个本地运行的 Web 工具，用于连接 MySQL、浏览库表、按固定模板执行查询，并把结果渲染成报告后截图保存到本地。当前实现已适配 Windows、macOS、Linux 三个平台，截图浏览器优先通过环境变量配置，其次按平台常见路径自动发现。

## 当前状态

当前版本的运行形态如下：

- 运行时主代码是 `server.js` 和 `public/` 下的静态页面。
- 当前前端不是自由 SQL 编辑器，而是 5 个固定查询模板的工作台。
- 批量任务目前只保存在页面内存中，刷新页面后会丢失。
- 成功截图输出到 `captures/`，失败日志输出到 `logs/`。
- 临时 HTML 报告默认只在截图失败时写入 `tmp/`，成功路径不再先写后删。

如果你要继续维护，请先看 [MAINTAINER_GUIDE.md](./MAINTAINER_GUIDE.md)。

## 核心能力

- 连接本机或局域网中的 MySQL
- 浏览数据库、表、字段结构和表数据预览
- 对单张表执行固定模板查询
- 将单表查询结果截图保存到本地
- 对勾选的多张表生成批量任务并批量截图
- 一键复制已选表的全部模板 SQL，也可以选择跳过「查询表结构」模板只导出业务查询
- 为失败任务生成本地日志，便于排查

## 运行要求

- **操作系统**：Windows / macOS / Linux
- **Node.js**：22+，当前已验证环境为 `v24.14.0`
  - Node 运行时需要提供全局 `fetch` 和 `WebSocket`（Node 18+ 原生支持，无需 polyfill）
- **数据库**：可访问的 MySQL 服务
- **浏览器**：本机安装以下浏览器之一，用于执行截图
  - Microsoft Edge
  - Google Chrome

浏览器查找顺序如下：

1. `BROWSER_PATH` 环境变量
2. 当前平台的常见安装路径
3. macOS / Linux 上的 `which` 命令回退查找

可选环境变量：

- `HOST`：服务监听地址，默认 `127.0.0.1`
- `PORT`：服务端口，默认 `3811`
- `BROWSER_PATH`：显式指定浏览器可执行文件路径
- `BROWSER_CHANNEL`：当使用 `BROWSER_PATH` 时显示的浏览器名称

## 启动

```bash
npm install
npm start
```

也可以先复制 `.env.example` 为 `.env` 后按需填写环境变量。

服务默认启动在：

```text
http://127.0.0.1:3811
```

如果需要改端口，可以在启动前设置 `PORT`：

```powershell
$env:PORT='3813'
npm start
```

页面入口：

- `/`：数据库登录页
- `/app`：查询工作台

## 目录说明

- `server.js`
  后端入口，负责 API 路由、请求处理和静态资源分发。
- `lib/templates.js`
  固定模板 SQL 白名单、字段识别、模板可用性判断。
- `lib/mysql.js`
  MySQL 连接池与只读查询、库表字段访问。
- `lib/capture.js`
  浏览器发现、截图会话、跨平台目录打开和截图产物生成。
- `public/`
  前端页面与样式。实际运行入口是 `public/login.html`、`public/index.html`、`public/login.js`、`public/app.js`、`public/login.css`、`public/styles.css`。
- `captures/`
  成功生成的 PNG 截图输出目录。
- `logs/`
  失败任务的日志目录。
- `tmp/`
  失败时保留的临时 HTML 报告目录和运行期临时文件目录。
## 当前界面流程

### 1. 登录页

- 页面只保存 `host / port / user` 草稿到浏览器本地存储
- 数据库密码不会写入本地存储
- 连接成功后跳转到 `/app`

### 2. 查询工作台

工作台分 3 步：

1. 选择数据库与目标表
2. 对当前试跑表做字段预览、数据预览、单表查询或单表截图
3. 生成批量任务并统一执行截图

### 3. 固定模板

当前固定模板共 5 个：

- `查询时间范围`
- `查询区域分布`
- `查询总行数`
- `查询表结构`
- `查询存储空间`

说明：

- 前端 SQL 文本框是只读预览，不支持直接输入任意 SQL。
- 模板 SQL 由前端根据当前表动态生成。
- 服务端会对模板 SQL 再做白名单校验。
- 服务端静态文件访问和目录打开都限制在受控根目录内，避免路径穿越到工作区外。
- `查询存储空间` 执行前，系统会对相关表自动执行一次 `ANALYZE TABLE`，以确保 `information_schema.TABLES.data_length` 是最新值。这是隐式写入（更新统计信息），工具不是绝对零写入的数据库工具。其他 4 个模板不会触发 ANALYZE。

## 输出规则

单表或批量截图成功后，图片会写入：

```text
captures/<任务文件夹名>/<表名>/<固定图片名>.png
```

当前固定图片名规则：

- `记录时间`
- `表空间`
- `表行数`
- `区域数据`
- `表结构`

任务失败时：

- 日志写入 `logs/<时间戳>-<任务名>.log`
- 对应的临时 HTML 报告会保留在 `tmp/`

## 截图实现说明

- 截图通过本机可用的 Chromium 内核浏览器完成。
- 成功路径直接使用内存中的 HTML 字符串截图，失败时才保留临时 HTML 到 `tmp/`。
- 浏览器预热和会话复用已内置在后端服务中，调用方不需要感知平台差异。

## 状态持久化

当前状态分为两类：

- 服务端内存状态
  - 当前数据库连接配置
  - 当前 MySQL 连接池
- 浏览器本地存储
  - 登录页：`host / port / user`
  - 工作台：当前模板 ID、当前生成的 SQL 预览

当前不会持久化的内容：

- 批量任务列表
- 单表查询结果
- 预览数据
- 数据库密码

## API 简表

当前主要接口如下：

- `GET /api/status`
  返回当前是否已连接数据库、截图浏览器是否可用、当前连接元信息。
- `POST /api/connect`
  建立数据库连接并初始化连接池。
- `GET /api/databases`
  列出数据库。
- `GET /api/tables?database=<db>`
  列出表和模板可用性。
- `GET /api/columns?database=<db>&table=<table>`
  列出字段结构。
- `GET /api/preview?database=<db>&table=<table>&limit=<n>`
  预览表数据。
- `POST /api/query`
  执行单个模板查询，可选截图。
- `POST /api/analyze-table`
  对指定表执行 `ANALYZE TABLE` 刷新统计信息。不生成截图，失败时写入 `logs/`。前端在执行 `查询存储空间` 前会自动调用。
- `POST /api/automation/run`
  保留的批量接口，目前前端主流程不依赖它。

注意：

- `/api/query` 当前只接受固定模板形状的 SQL，不接受任意只读 SQL。`ANALYZE TABLE` 已从模板白名单剥离，必须走 `/api/analyze-table`。
- `assertReadOnlySql()` 仍然存在于后端，但当前 UI 主流程没有开放自由 SQL 编辑入口。

## 开源化建议

如果要把项目正式作为开源仓库发布，至少还应补齐这些内容：

- 明确 LICENSE、维护者、仓库地址和 issue 渠道
- 增加 `CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`
- 清理示例截图、日志、临时文件，避免把业务数据带入仓库
- 增加最小自动化校验，例如 `node --check` 和关键 API smoke test

## 已知限制

- **单用户架构**：当前后端是单进程、单全局连接状态，不适合多用户同时使用。
- **截图依赖本机浏览器**：运行截图功能的机器必须安装受支持的浏览器，或显式配置 `BROWSER_PATH`。
- **没有自动化测试**：没有自动化测试、没有 lint、没有类型系统。

## 移植到其他环境的注意事项

如果你打算将本项目复制到其他环境运行，请注意以下几点：

### 1. 跨平台浏览器配置

优先通过 `BROWSER_PATH` 指定浏览器可执行文件路径；未设置时，程序会按平台常见路径自动查找。

### 2. Node.js 版本要求

确保目标环境的 Node.js 版本满足以下任一条件：
- Node.js 18+：原生支持全局 `fetch` 和 `WebSocket`，可直接运行
- Node.js 16 或更低版本：需要自行引入 polyfill

### 3. 目录权限

确保运行环境对以下目录有读写权限：
- `captures/` - 截图输出
- `logs/` - 失败日志
- `tmp/` - 临时文件

### 4. 网络访问

- 服务端默认监听 `127.0.0.1:3811`，如需允许局域网访问，请通过环境变量 `HOST` 调整
- 确保目标环境可以访问 MySQL 服务

### 5. 架构限制

本项目定位为"本机使用的内部工具原型"，不适合以下场景：
- 多用户并发访问
- 公网部署
- 需要持久化任务记录的场景

## 维护入口

继续开发前，建议按这个顺序阅读：

1. [MAINTAINER_GUIDE.md](./MAINTAINER_GUIDE.md)
2. `server.js`
3. `public/app.js`
4. `public/index.html`
5. `public/login.js`
