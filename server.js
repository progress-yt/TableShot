const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2');
const mysqlPromise = require('mysql2/promise');
const {
  assertAllowedQuery,
  assertReadOnlySql,
  buildDetectedFields,
  buildFieldCandidates,
  buildTemplateAvailability,
  guessTaskFailureReason,
  isAllowedTemplateQuery,
  resolveCaptureFileName
} = require('./lib/templates');
const { createMysqlService } = require('./lib/mysql');
const { createCaptureService } = require('./lib/capture');

const HOST = String(process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
const PORT = Number(process.env.PORT || 3811);
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const CAPTURES_DIR = path.join(ROOT_DIR, 'captures');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const TMP_DIR = path.join(ROOT_DIR, 'tmp');
const MAX_BODY_SIZE = 2 * 1024 * 1024;
const DEFAULT_PREVIEW_LIMIT = 30;
const MAX_CAPTURE_ROWS = 150;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

const state = {
  connectionConfig: null,
  connectionPool: null
};

function toRepoRelativePath(absolutePath) {
  return path.relative(ROOT_DIR, absolutePath).split(path.sep).join('/');
}

function nowStamp() {
  const date = new Date();
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
    '-',
    String(date.getMilliseconds()).padStart(3, '0')
  ].join('');
}

function sanitizeFileName(value) {
  return String(value || 'query')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'query';
}

function formatDateOnly(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function serializeValue(value, fieldType) {
  if (value === null || value === undefined) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return `0x${value.toString('hex')}`;
  }
  if (value instanceof Date) {
    if (fieldType === mysql.Types.DATE || fieldType === mysql.Types.NEWDATE) {
      return formatDateOnly(value);
    }
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

function normalizeRows(rows, fields = []) {
  const fieldTypeByName = new Map(fields.map((field) => [field.name, field.columnType]));

  if (!Array.isArray(rows)) {
    return [
      Object.fromEntries(
        Object.entries(rows).map(([key, value]) => [key, serializeValue(value, fieldTypeByName.get(key))])
      )
    ];
  }

  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, serializeValue(value, fieldTypeByName.get(key))])
    )
  );
}

async function ensureDirectories() {
  await Promise.all([
    fsp.mkdir(PUBLIC_DIR, { recursive: true }),
    fsp.mkdir(CAPTURES_DIR, { recursive: true }),
    fsp.mkdir(LOGS_DIR, { recursive: true }),
    fsp.mkdir(TMP_DIR, { recursive: true })
  ]);
}

const mysqlService = createMysqlService({
  state,
  normalizeRows,
  defaultPreviewLimit: DEFAULT_PREVIEW_LIMIT,
  buildDetectedFields,
  buildFieldCandidates,
  buildTemplateAvailability,
  assertAllowedQuery,
  assertReadOnlySql,
  isAllowedTemplateQuery
});

const captureService = createCaptureService({
  rootDir: ROOT_DIR,
  capturesDir: CAPTURES_DIR,
  tmpDir: TMP_DIR,
  maxCaptureRows: MAX_CAPTURE_ROWS,
  maxCaptureWidth: 2200,
  maxCaptureHeight: 9000,
  minCaptureWidth: 420,
  minCaptureHeight: 220,
  sanitizeFileName,
  resolveCaptureFileName,
  ensureDirectories
});

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function textResponse(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      throw Object.assign(new Error('请求体过大，已超过 2MB 限制。'), { statusCode: 400 });
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function ensureConnected() {
  if (!state.connectionConfig) {
    throw Object.assign(new Error('尚未建立数据库连接。请先在页面上完成连接。'), { statusCode: 400 });
  }
}

async function writeTaskFailureLog(context, error, reason) {
  await ensureDirectories();

  const stamp = nowStamp();
  const safeTaskName = sanitizeFileName(context.taskName || context.table || 'task-error');
  const logPath = path.join(LOGS_DIR, `${stamp}-${safeTaskName}.log`);
  const lines = [
    `Timestamp: ${new Date().toISOString()}`,
    `Reason: ${reason}`,
    `Database: ${context.database || ''}`,
    `Table: ${context.table || ''}`,
    `Task Name: ${context.taskName || ''}`,
    `Template: ${context.templateName || ''}`,
    `Error Code: ${error?.code || ''}`,
    `Error Message: ${error?.message || ''}`,
    '',
    'SQL:',
    context.sql || '',
    ''
  ];

  if (error?.stack) {
    lines.push('Stack:', error.stack, '');
  }

  await fsp.writeFile(logPath, lines.join('\n'), 'utf8');
  return logPath;
}

async function annotateTaskError(error, context) {
  if (error.annotatedTaskError) {
    return error;
  }

  const reason = guessTaskFailureReason(error, context);
  const absoluteLogPath = await writeTaskFailureLog(context, error, reason);
  const logPath = toRepoRelativePath(absoluteLogPath);
  const rawMessage = String(error.message || '').trim();
  const message = rawMessage && rawMessage !== reason
    ? `${reason} 详细信息：${rawMessage} 本地日志：${logPath}`
    : `${reason} 本地日志：${logPath}`;

  error.annotatedTaskError = true;
  error.reason = reason;
  error.logPath = logPath;
  error.message = message;
  return error;
}

function toPublicArtifact(artifact) {
  if (!artifact) {
    return null;
  }

  return {
    imagePath: artifact.imagePath ? toRepoRelativePath(artifact.imagePath) : '',
    imageUrl: artifact.imageUrl || ''
  };
}

function resolveStaticPath(baseDir, requestedName) {
  let decodedName = '';
  try {
    decodedName = decodeURIComponent(String(requestedName || ''));
  } catch {
    throw Object.assign(new Error('非法文件路径。'), { statusCode: 400 });
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(resolvedBase, `.${path.sep}${decodedName}`);
  const relative = path.relative(resolvedBase, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('非法文件路径。'), { statusCode: 400 });
  }
  return resolvedPath;
}

async function serveFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || 'application/octet-stream';
  const data = await fsp.readFile(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Cache-Control': extension === '.html' || extension === '.js' || extension === '.css' || extension === '.png'
      ? 'no-store'
      : 'public, max-age=3600'
  });
  res.end(data);
}

async function handleConnect(req, res) {
  const payload = await readJsonBody(req);
  const host = String(payload.host || '').trim() || '127.0.0.1';
  const port = Math.max(1, Math.min(65535, Number(payload.port) || 3306));
  const user = String(payload.user || '').trim();
  const password = String(payload.password || '');

  if (!user) {
    throw Object.assign(new Error('用户名不能为空。'), { statusCode: 400 });
  }

  const testConfig = { host, port, user, password, connectTimeout: 8000 };
  const connection = await mysqlPromise.createConnection(testConfig);
  let version = 'unknown';
  try {
    const [rows] = await connection.query('SELECT VERSION() AS version');
    version = rows[0] && rows[0].version ? String(rows[0].version) : version;
  } finally {
    await connection.end();
  }

  await mysqlService.closeConnectionPool();
  state.connectionConfig = testConfig;
  state.connectionPool = mysqlService.createConnectionPool(testConfig);
  const databases = await mysqlService.listDatabases();

  jsonResponse(res, 200, {
    ok: true,
    version,
    databases,
    browser: captureService.findBrowser() ? 'available' : 'missing',
    connection: { host, port, user }
  });
}

async function handleStatus(_req, res) {
  jsonResponse(res, 200, {
    connected: Boolean(state.connectionConfig),
    browser: captureService.findBrowser() ? 'available' : 'missing',
    connection: state.connectionConfig
      ? {
          host: state.connectionConfig.host,
          port: state.connectionConfig.port,
          user: state.connectionConfig.user
        }
      : null
  });
}

async function handleCaptureWarmup(req, res) {
  const payload = await readJsonBody(req);
  const keys = Array.isArray(payload.keys)
    ? payload.keys.map((key) => String(key || '').trim()).filter(Boolean)
    : [];
  const uniqueKeys = [...new Set(keys)];

  if (!uniqueKeys.length) {
    jsonResponse(res, 200, { ok: true, warmed: 0 });
    return;
  }

  await Promise.all(uniqueKeys.map((key) => captureService.warmupCaptureSession(key)));
  jsonResponse(res, 200, { ok: true, warmed: uniqueKeys.length });
}

async function handleAnalyzeTable(req, res) {
  const payload = await readJsonBody(req);
  const database = String(payload.database || '').trim();
  const table = String(payload.table || '').trim();
  const taskName = `analyze-${sanitizeFileName(table) || 'unknown'}`;

  if (!table) {
    throw Object.assign(new Error('缺少目标表名称。'), { statusCode: 400 });
  }

  try {
    const rows = await mysqlService.analyzeTable(database || null, table);
    const errorRow = rows.find((row) => String(row?.Msg_type || row?.msg_type || '').toLowerCase() === 'error');
    if (errorRow) {
      throw Object.assign(
        new Error(String(errorRow.Msg_text || errorRow.msg_text || 'ANALYZE TABLE 返回错误。').trim()),
        { statusCode: 500 }
      );
    }

    const statusRow = rows.find((row) => String(row?.Msg_type || row?.msg_type || '').toLowerCase() === 'status');
    jsonResponse(res, 200, {
      ok: true,
      database,
      table,
      status: 'analyzed',
      note: statusRow ? String(statusRow.Msg_text || statusRow.msg_text || '').trim() : ''
    });
  } catch (error) {
    await annotateTaskError(error, {
      database,
      table,
      taskName,
      templateName: 'ANALYZE TABLE',
      sql: `ANALYZE TABLE ${mysql.escapeId(table)}`
    });
    throw error;
  }
}

async function handleOpenFolder(req, res) {
  const payload = await readJsonBody(req);
  const absolute = captureService.resolveAllowedFolderPath(payload.path);

  let stat;
  try {
    stat = await fsp.stat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw Object.assign(new Error('目标目录还不存在，可能是任务尚未生成输出。'), { statusCode: 404 });
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    throw Object.assign(new Error('目标路径不是一个目录。'), { statusCode: 400 });
  }

  await captureService.openFolder(absolute);
  jsonResponse(res, 200, { ok: true, path: absolute });
}

async function handleQuery(req, res) {
  const payload = await readJsonBody(req);
  const database = String(payload.database || '').trim();
  const table = payload.table ? String(payload.table).trim() : '';
  const tableComment = payload.tableComment ? String(payload.tableComment).trim() : '';
  const taskName = String(payload.taskName || `${table || 'query'}-capture`).trim();
  const templateId = String(payload.templateId || '').trim();
  const templateName = String(payload.imageName || 'capture').trim();
  const captureOptions = payload.captureOptions && typeof payload.captureOptions === 'object'
    ? payload.captureOptions
    : {};

  try {
    const sql = assertAllowedQuery(payload.sql || '');
    const result = await mysqlService.executeReadOnlyQuery(database || null, sql);

    let artifact = null;
    if (payload.capture) {
      artifact = await captureService.createArtifact({
        taskName: sanitizeFileName(taskName),
        templateId,
        imageName: templateName || 'capture',
        database,
        table,
        tableComment,
        sql,
        result,
        captureProfileKey: payload.captureProfileKey || '',
        captureOptions
      });
      artifact = toPublicArtifact(artifact);
    }

    jsonResponse(res, 200, { ok: true, sql, result, artifact });
  } catch (error) {
    await annotateTaskError(error, {
      database,
      table,
      taskName,
      templateName,
      sql: payload.sql || ''
    });
    throw error;
  }
}

async function handleAutomation(req, res) {
  const payload = await readJsonBody(req);
  const database = String(payload.database || '').trim();
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];

  if (!database) {
    throw Object.assign(new Error('请先选择数据库。'), { statusCode: 400 });
  }

  if (!tasks.length) {
    throw Object.assign(new Error('至少需要一个自动任务。'), { statusCode: 400 });
  }

  const results = [];

  for (const task of tasks) {
    const taskName = String(task.name || '').trim() || 'unnamed-task';
    const sqlTemplate = String(task.sql || '').trim();
    const tableComment = task.tableComment ? String(task.tableComment).trim() : '';
    const templateId = String(task.templateId || '').trim();
    const templateName = String(task.imageName || 'capture').trim();
    const captureOptions = task.captureOptions && typeof task.captureOptions === 'object'
      ? task.captureOptions
      : {};

    if (!sqlTemplate) {
      const error = await annotateTaskError(new Error('任务 SQL 为空，已跳过。'), {
        database,
        table: task.table || '',
        taskName,
        templateName,
        sql: sqlTemplate
      });
      results.push({ taskName, table: task.table || '', error: error.message, reason: error.reason, logPath: error.logPath });
      continue;
    }

    if (sqlTemplate.startsWith('--')) {
      const error = await annotateTaskError(new Error(sqlTemplate.slice(2).trim() || '任务不可执行。'), {
        database,
        table: task.table || '',
        taskName,
        templateName,
        sql: sqlTemplate
      });
      results.push({ taskName, table: task.table || '', error: error.message, reason: error.reason, logPath: error.logPath });
      continue;
    }

    try {
      const sql = assertAllowedQuery(sqlTemplate);
      const result = await mysqlService.executeReadOnlyQuery(database, sql);
      const artifact = toPublicArtifact(await captureService.createArtifact({
        taskName,
        templateId,
        imageName: templateName || 'capture',
        database,
        table: task.table || '',
        tableComment,
        sql,
        result,
        captureOptions
      }));

      results.push({
        taskName,
        table: task.table || '',
        sql,
        rowCount: result.rows.length,
        columns: result.columns,
        artifact
      });
    } catch (error) {
      await annotateTaskError(error, {
        database,
        table: task.table || '',
        taskName,
        templateName,
        sql: sqlTemplate
      });
      results.push({
        taskName,
        table: task.table || '',
        sql: sqlTemplate,
        error: error.message,
        reason: error.reason,
        logPath: error.logPath
      });
    }
  }

  jsonResponse(res, 200, { ok: true, results });
}

async function routeApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return handleStatus(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/connect') {
    return handleConnect(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/databases') {
    ensureConnected();
    return jsonResponse(res, 200, { ok: true, databases: await mysqlService.listDatabases() });
  }
  if (req.method === 'GET' && url.pathname === '/api/tables') {
    ensureConnected();
    const database = String(url.searchParams.get('database') || '').trim();
    if (!database) {
      throw Object.assign(new Error('缺少数据库名称。'), { statusCode: 400 });
    }
    return jsonResponse(res, 200, { ok: true, tables: await mysqlService.listTables(database) });
  }
  if (req.method === 'GET' && url.pathname === '/api/columns') {
    ensureConnected();
    const database = String(url.searchParams.get('database') || '').trim();
    const table = String(url.searchParams.get('table') || '').trim();
    if (!database || !table) {
      throw Object.assign(new Error('缺少数据库或表名。'), { statusCode: 400 });
    }
    return jsonResponse(res, 200, { ok: true, columns: await mysqlService.listColumns(database, table) });
  }
  if (req.method === 'GET' && url.pathname === '/api/preview') {
    ensureConnected();
    const database = String(url.searchParams.get('database') || '').trim();
    const table = String(url.searchParams.get('table') || '').trim();
    const limit = String(url.searchParams.get('limit') || '').trim();
    if (!database || !table) {
      throw Object.assign(new Error('缺少数据库或表名。'), { statusCode: 400 });
    }
    return jsonResponse(res, 200, { ok: true, result: await mysqlService.previewTable(database, table, limit) });
  }
  if (req.method === 'POST' && url.pathname === '/api/capture/warmup') {
    ensureConnected();
    return handleCaptureWarmup(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/analyze-table') {
    ensureConnected();
    return handleAnalyzeTable(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/open-folder') {
    return handleOpenFolder(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/query') {
    ensureConnected();
    return handleQuery(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/automation/run') {
    ensureConnected();
    return handleAutomation(req, res);
  }
  textResponse(res, 404, 'Not found');
}

async function routeStatic(_req, res, url) {
  if (url.pathname === '/' || url.pathname === '/login') {
    return serveFile(res, path.join(PUBLIC_DIR, 'login.html'));
  }
  if (url.pathname === '/app') {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (url.pathname.startsWith('/captures/')) {
    return serveFile(res, resolveStaticPath(CAPTURES_DIR, url.pathname.slice('/captures/'.length)));
  }
  const relativePath = url.pathname.replace(/^\/+/, '');
  return serveFile(res, resolveStaticPath(PUBLIC_DIR, relativePath));
}

async function requestListener(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      await routeApi(req, res, url);
      return;
    }

    await routeStatic(req, res, url);
  } catch (error) {
    const statusCode = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
    const message = statusCode === 404 ? '资源不存在。' : error.message || '服务器发生未知错误。';
    jsonResponse(res, statusCode, {
      ok: false,
      message,
      reason: error.reason || null,
      logPath: error.logPath || null
    });
  }
}

async function startServer() {
  await fsp.rm(path.join(TMP_DIR, 'browser-profile'), { recursive: true, force: true }).catch(() => {});
  await ensureDirectories();
  const server = http.createServer(requestListener);
  server.on('close', () => {
    captureService.shutdownBrowserSessions().catch(() => {});
  });
  await new Promise((resolve) => {
    server.listen(PORT, HOST, resolve);
  });
  console.log(`MySQL capture tool is running at http://${HOST}:${PORT}`);
  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  startServer,
  assertReadOnlySql
};
