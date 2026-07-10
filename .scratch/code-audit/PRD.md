# TableShot 代码审计与修复记录

日期：2026-07-10
状态：实现完成，自动化验证通过

## 目标

系统分析 TableShot 的后端、MySQL、截图、前端和维护契约，修复能够在本地确定性复现的问题，并为每类根因建立自动化回归测试。

## 已完成

- 查询边界：移除客户端 SQL，统一为服务端模板、prepared statement、元数据字段验证与显式 `ANALYZE TABLE` 确认。
- 网络边界：只绑定数值 loopback，校验 Host/Origin/JSON，并加入 CSP、CORP、COOP 等响应头。
- MySQL 资源：连接池原子替换、有限队列、查询超时、元数据/预览/结果上限和 TLS 配置脱敏。
- 大值控制：预览最多 100 行、64 列、文本 512 字符；二进制/空间/向量只返回字节摘要；区域模板最多 500 行且单值 512 字符。
- 文件边界：拒绝链接根、路径穿越、NTFS ADS 和 Windows 保留名；静态前端使用固定白名单内存缓存；截图不再通过 HTTP 提供。
- 截图产物：run 级目录、非覆盖原子发布、私有权限、像素/尺寸/行数预算和显式截断元数据。
- Chromium 生命周期：会话容量、stopping 会话计数、有限 deadline 队列、取消传播、stale 重试、空闲回收和 shutdown 等待。
- 诊断数据：4xx 不落失败日志；内部日志与失败 HTML 均有文件数、单文件、总字节预算，控制字符归一化并使用私有权限。
- 清理安全：自动删除默认关闭；日志过期内容通过已验证句柄清空；retention 不跟随符号链接、junction 或 stale Dirent。
- 前端一致性：请求取消、单/批任务锁、准确取消 ledger、分页、预览模式 API 隔离、截断提示、键盘/对话框/减少动画可访问性。
- 工程化：Node 22/24 CI、ESLint、语法检查、HTTP smoke、README/SECURITY/ADR/维护指南同步。

## 验证结果

- `npm run check`：15 个 JavaScript 文件通过。
- `npm run lint`：通过。
- `npm test`：85/85 通过。
- 真实应用 HTTP smoke：登录页、预览资产、安全响应头、断开状态与关闭流程通过。
- `npm audit --audit-level=high`：0 个漏洞。
- `git diff --check`：通过（仅提示工作区将在 Git 写入时按配置转换为 CRLF）。

## 已知验证边界

- 未连接真实 MySQL；prepared statement、查询超时与元数据行为由可控连接替身验证。
- 未启动真实 Edge/Chrome 完成 PNG 截图；Chromium/CDP 生命周期由可控进程与文件替身验证。
- 同一操作系统账号下、同时拥有仓库写权限的恶意进程不属于隔离边界；详见 `SECURITY.md`。
