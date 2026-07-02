# Maintainer Guide

这个文档提供面向维护者的高层说明，避免记录本地环境、个人路径、调试残留和不必要的运行细节。

## 模块结构

- `server.js`
  请求路由、响应封装、错误注解、静态资源分发、服务启动。
- `lib/templates.js`
  固定模板 SQL 白名单、字段自动识别、模板可用性判断。
- `lib/mysql.js`
  MySQL 连接池、只读查询、数据库/表/字段访问。
- `lib/capture.js`
  浏览器发现、截图会话、截图产物生成、跨平台打开目录。
- `public/`
  前端登录页和查询工作台。

## 运行边界

- 当前项目主要面向单用户、本地或受控内网环境。
- `/api/query` 仅允许固定模板形状的 SQL。
- 失败日志和截图输出都限制在仓库工作目录下的受控子目录。
- 浏览器路径优先由 `BROWSER_PATH` 指定，其次由程序按平台常见路径查找。

## 维护建议

- 新增查询能力时，优先扩展 `lib/templates.js` 的白名单和模板判定，不要回退到自由 SQL。
- 新增数据库访问逻辑时，优先放入 `lib/mysql.js`，保持 `server.js` 只负责编排。
- 新增截图或文件操作时，继续沿用受控目录校验，不要暴露绝对路径给前端。
- 发布前检查 `.gitignore`，避免把 `captures/`、`logs/`、`tmp/` 和本地环境文件提交到仓库。

## 发布前检查

```bash
node --check server.js
node --check lib/templates.js
node --check lib/mysql.js
node --check lib/capture.js
```

## 安全说明

- 不在仓库中提交真实数据库地址、账号、密码、日志样本或截图样本。
- 不在公开文档中记录本机目录、用户名、浏览器 profile 细节或事故复盘细节。
- 如发现安全问题，建议通过私下渠道联系维护者处理，公开修复后再补充公告。

