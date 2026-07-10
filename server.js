const http = require('node:http');
const { constants: FS_CONSTANTS } = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2');
const {
  buildDetectedFields,
  buildFieldCandidates,
  buildTemplateAvailability,
  buildTemplateQuery,
  guessTaskFailureReason,
  listPublicTemplates,
  resolveCaptureFileName
} = require('./lib/templates');
const { createMysqlService } = require('./lib/mysql');
const { createCaptureService } = require('./lib/capture');

const ROOT_DIR = __dirname;
const DEFAULT_PORT = 3811;
const MAX_BODY_SIZE = 2 * 1024 * 1024;
const DEFAULT_PREVIEW_LIMIT = 30;
const MAX_CAPTURE_ROWS = 150;
const MAX_WARMUP_KEYS = 8;
const MAX_WARMUP_CONCURRENCY = 3;
const MAX_CONCURRENT_API_REQUESTS = 24;
const DEFAULT_MAX_FAILURE_LOG_FILES = 100;
const DEFAULT_MAX_FAILURE_LOG_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_FAILURE_LOG_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_PUBLIC_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_PUBLIC_ASSET_TOTAL_BYTES = 16 * 1024 * 1024;
const PUBLIC_ASSET_NAMES = Object.freeze([
  'login.html',
  'index.html',
  'login.css',
  'styles.css',
  'login.js',
  'app-core.js',
  'app.js'
]);
const INTERNAL_FAILURE_LOG_PATTERN = /^tableshot-\d{8}-\d{6}-\d{3}-\d{1,6}-.{1,80}\.log$/u;
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1']);
const LOOPBACK_REQUEST_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const CAPTURE_PROFILE_PATTERN = /^(?:single-run-preview|batch-worker-[0-5])$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
});

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

function httpError(statusCode, message, options = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = options.expose ?? statusCode < 500;
  error.code = options.code;
  return error;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (/^(?:1|true|yes|on)$/u.test(normalized)) {
    return true;
  }
  if (/^(?:0|false|no|off)$/u.test(normalized)) {
    return false;
  }
  throw httpError(500, '布尔环境变量必须使用 true 或 false。', { expose: true });
}

function normalizeLoopbackHostname(value) {
  const hostname = String(value || '').trim().toLowerCase();
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasSameFileIdentity(first, second) {
  return Boolean(first && second
    && first.dev === second.dev
    && first.ino === second.ino
    && first.ino !== 0n);
}

async function ensureDirectoryWithinRoot(root, directory, label) {
  const absoluteRoot = path.resolve(root);
  const absoluteDirectory = path.resolve(directory);
  if (!isPathWithin(absoluteRoot, absoluteDirectory)) {
    throw httpError(500, `${label}超出项目目录边界。`);
  }

  await fsp.mkdir(absoluteRoot, { recursive: true });
  const realRoot = await fsp.realpath(absoluteRoot);
  const relative = path.relative(absoluteRoot, absoluteDirectory);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = absoluteRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fsp.mkdir(current);
      stat = await fsp.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw httpError(500, `${label}包含符号链接或非目录节点。`);
    }
    const realCurrent = await fsp.realpath(current);
    if (!isPathWithin(realRoot, realCurrent)) {
      throw httpError(500, `${label}通过链接指向项目目录之外。`);
    }
  }
  return current;
}

function readServerConfig(env = process.env) {
  const requestedHost = String(env.HOST || '127.0.0.1').trim() || '127.0.0.1';
  const host = normalizeLoopbackHostname(requestedHost);
  if (!LOOPBACK_BIND_HOSTS.has(host)) {
    throw httpError(500, '为避免 DNS/hosts 绕过，HOST 只能使用数值 loopback：127.0.0.1 或 ::1。', { expose: true });
  }

  const port = Number(env.PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw httpError(500, 'PORT 必须是 1 到 65535 之间的整数。', { expose: true });
  }
  const logRetentionMs = Number(env.LOG_RETENTION_MS || 0);
  if (!Number.isSafeInteger(logRetentionMs) || logRetentionMs < 0) {
    throw httpError(500, 'LOG_RETENTION_MS 必须是非负整数。', { expose: true });
  }

  const rawQueryTimeout = env.MYSQL_QUERY_TIMEOUT_MS;
  const queryTimeoutMs = rawQueryTimeout === undefined || rawQueryTimeout === ''
    ? 15_000
    : Number(rawQueryTimeout);
  if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1_000 || queryTimeoutMs > 120_000) {
    throw httpError(500, 'MYSQL_QUERY_TIMEOUT_MS 必须是 1000 到 120000 之间的整数。', { expose: true });
  }

  return {
    host,
    port,
    mysqlSslCaPath: String(env.MYSQL_SSL_CA_PATH || '').trim(),
    mysqlSslRejectUnauthorized: env.MYSQL_SSL_REJECT_UNAUTHORIZED === undefined
      ? true
      : parseBoolean(env.MYSQL_SSL_REJECT_UNAUTHORIZED, true),
    queryTimeoutMs,
    logRetentionMs
  };
}

function toRepoRelativePath(rootDir, value) {
  if (!value) {
    return '';
  }
  const absoluteRoot = path.resolve(rootDir);
  const stringValue = String(value);
  const absoluteValue = path.isAbsolute(stringValue)
    ? path.resolve(stringValue)
    : path.resolve(absoluteRoot, stringValue);
  const relative = path.relative(absoluteRoot, absoluteValue);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw httpError(500, '内部路径超出项目目录边界。');
  }
  return relative.split(path.sep).join('/');
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
  const sanitized = String(value || 'query')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 80);
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : 'query';
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
  const rowList = Array.isArray(rows) ? rows : [rows];
  return rowList.map((row) => Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [key, serializeValue(value, fieldTypeByName.get(key))])
  ));
}

function safeLog(logger, level, ...args) {
  try {
    const method = logger?.[level];
    if (typeof method === 'function') {
      method.call(logger, ...args);
    }
  } catch {
    // Logging must never alter request or shutdown control flow.
  }
}

function jsonResponse(res, statusCode, payload) {
  if (res.writableEnded) {
    return;
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function assertJsonContentType(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    throw httpError(415, '该接口仅接受 Content-Type: application/json。');
  }
}

async function readJsonBody(req) {
  assertJsonContentType(req);

  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
    throw httpError(413, '请求体过大，已超过 2MB 限制。');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      throw httpError(413, '请求体过大，已超过 2MB 限制。');
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('JSON root must be an object');
    }
    return parsed;
  } catch {
    throw httpError(400, '请求体必须是有效的 JSON 对象。');
  }
}

function resolveStaticPath(baseDir, requestedName) {
  let decodedName;
  try {
    decodedName = decodeURIComponent(String(requestedName || ''));
  } catch {
    throw httpError(400, '非法文件路径。');
  }
  if (decodedName.includes('\0')) {
    throw httpError(400, '非法文件路径。');
  }
  if (decodedName.split(/[\\/]/u).some((segment) => segment.includes(':'))) {
    throw httpError(400, '文件路径不允许使用数据流或驱动器语法。');
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(resolvedBase, `.${path.sep}${decodedName}`);
  const relative = path.relative(resolvedBase, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw httpError(400, '非法文件路径。');
  }
  return resolvedPath;
}

function parseRequestUrl(req) {
  const rawHost = Array.isArray(req.headers.host) ? req.headers.host[0] : String(req.headers.host || '').trim();
  if (!rawHost) {
    throw httpError(400, '缺少 Host 请求头。');
  }

  let authority;
  try {
    authority = new URL(`http://${rawHost}`);
  } catch {
    throw httpError(400, 'Host 请求头格式非法。');
  }
  if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) {
    throw httpError(400, 'Host 请求头格式非法。');
  }
  const hostname = normalizeLoopbackHostname(authority.hostname);
  if (!LOOPBACK_REQUEST_HOSTS.has(hostname)) {
    throw httpError(403, '仅允许通过本机 loopback 地址访问。');
  }

  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    throw httpError(403, '已拒绝跨站请求。');
  }

  const rawOrigin = String(req.headers.origin || '').trim();
  if (rawOrigin) {
    let origin;
    try {
      origin = new URL(rawOrigin);
    } catch {
      throw httpError(403, 'Origin 请求头格式非法。');
    }
    if (origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw httpError(403, '仅允许本地同源请求。');
    }
    const originHostname = normalizeLoopbackHostname(origin.hostname);
    if (!LOOPBACK_REQUEST_HOSTS.has(originHostname) || origin.host.toLowerCase() !== authority.host.toLowerCase()) {
      throw httpError(403, '仅允许本地同源请求。');
    }
  }

  const requestTarget = String(req.url || '');
  if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) {
    throw httpError(400, '请求地址格式非法。');
  }
  try {
    return new URL(requestTarget, 'http://localhost');
  } catch {
    throw httpError(400, '请求地址格式非法。');
  }
}

function normalizeFields(value) {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'fields 必须是对象。');
  }
  const allowedRoles = new Set(['timeField', 'regionField']);
  const fields = {};
  for (const [role, rawValue] of Object.entries(value)) {
    if (!allowedRoles.has(role)) {
      throw httpError(400, `不支持的字段角色：${role}。`);
    }
    const field = String(rawValue || '').trim();
    if (field.length > 64 || /[\u0000-\u001f\u007f]/u.test(field)) {
      throw httpError(400, '字段名称格式非法。');
    }
    if (field) {
      fields[role] = field;
    }
  }
  return fields;
}

function normalizeStructuredName(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw httpError(400, `${label}不能为空。`);
  }
  if (normalized.length > 64 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw httpError(400, `${label}格式非法。`);
  }
  return normalized;
}

function normalizeStructuredQuery(payload) {
  if (Object.prototype.hasOwnProperty.call(payload, 'sql')) {
    throw httpError(400, '该接口不接受客户端 SQL，请提交 templateId 和 fields。');
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'captureOptions')) {
    throw httpError(400, 'captureOptions 由服务端模板决定，不接受客户端覆盖。');
  }
  const database = normalizeStructuredName(payload.database, '数据库名称');
  const table = normalizeStructuredName(payload.table, '表名称');
  const templateId = normalizeStructuredName(payload.templateId, '模板标识');
  if (payload.capture !== undefined && typeof payload.capture !== 'boolean') {
    throw httpError(400, 'capture 必须是布尔值。');
  }
  return {
    database,
    request: {
      table,
      templateId,
      fields: normalizeFields(payload.fields)
    }
  };
}

function normalizeRunId(value) {
  const runId = String(value || '').trim();
  if (runId && !RUN_ID_PATTERN.test(runId)) {
    throw httpError(400, 'runId 仅允许 1-64 位字母、数字、下划线和连字符。');
  }
  return runId;
}

function normalizeCaptureProfileKey(value) {
  const key = String(value || '').trim();
  if (key && !CAPTURE_PROFILE_PATTERN.test(key)) {
    throw httpError(400, 'captureProfileKey 不在允许范围内。');
  }
  return key;
}

async function mapWithConcurrency(values, concurrency, worker) {
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, runWorker));
}

function createApplication(options = {}) {
  const config = {
    host: '127.0.0.1',
    port: DEFAULT_PORT,
    mysqlSslCaPath: '',
    mysqlSslRejectUnauthorized: true,
    queryTimeoutMs: 15_000,
    logRetentionMs: 0,
    ...(options.config || readServerConfig(options.env))
  };
  if (!LOOPBACK_BIND_HOSTS.has(normalizeLoopbackHostname(config.host))) {
    throw httpError(500, '服务只能绑定数值 loopback 地址。', { expose: true });
  }
  config.host = normalizeLoopbackHostname(config.host);

  const logger = options.logger || console;
  const beforeStaticRead = typeof options.beforeStaticRead === 'function' ? options.beforeStaticRead : null;
  const beforeFailureLogWrite = typeof options.beforeFailureLogWrite === 'function'
    ? options.beforeFailureLogWrite
    : null;
  const beforeLogRetentionClear = typeof options.beforeLogRetentionClear === 'function'
    ? options.beforeLogRetentionClear
    : null;
  const rootDir = options.rootDir || ROOT_DIR;
  const publicDir = options.publicDir || path.join(rootDir, 'public');
  const capturesDir = options.capturesDir || path.join(rootDir, 'captures');
  const logsDir = options.logsDir || path.join(rootDir, 'logs');
  const tmpDir = options.tmpDir || path.join(rootDir, 'tmp');
  const maxFailureLogFiles = Math.max(1, Math.min(10_000,
    Number(options.maxFailureLogFiles) || DEFAULT_MAX_FAILURE_LOG_FILES));
  const maxFailureLogFileBytes = Math.max(256, Math.min(1024 * 1024,
    Number(options.maxFailureLogFileBytes) || DEFAULT_MAX_FAILURE_LOG_FILE_BYTES));
  const maxFailureLogTotalBytes = Math.max(maxFailureLogFileBytes, Math.min(100 * 1024 * 1024,
    Number(options.maxFailureLogTotalBytes) || DEFAULT_MAX_FAILURE_LOG_TOTAL_BYTES));
  const state = options.state || {
    connectionConfig: null,
    connectionPool: null,
    connectionHealthy: false
  };
  let publicAssetsPromise = null;

  async function readExactPublicAsset(fileHandle, assetBytes, assetName) {
    const data = Buffer.alloc(assetBytes);
    let offset = 0;
    while (offset < assetBytes) {
      const { bytesRead } = await fileHandle.read(data, offset, assetBytes - offset, offset);
      if (bytesRead <= 0) {
        throw httpError(500, `静态资源 ${assetName} 在读取期间被截短。`);
      }
      offset += bytesRead;
    }
    const sentinel = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytesRead } = await fileHandle.read(sentinel, 0, 1, assetBytes);
    if (extraBytesRead > 0) {
      throw httpError(500, `静态资源 ${assetName} 在读取期间超过大小限制。`);
    }
    return data;
  }

  async function loadPublicAssets() {
    await ensureDirectoryWithinRoot(rootDir, publicDir, '静态资源目录');
    const [realRoot, publicStat, realPublicDir] = await Promise.all([
      fsp.realpath(rootDir),
      fsp.lstat(publicDir),
      fsp.realpath(publicDir)
    ]);
    if (publicStat.isSymbolicLink() || !publicStat.isDirectory() || !isPathWithin(realRoot, realPublicDir)) {
      throw httpError(500, '静态资源目录超出允许范围。');
    }

    const assets = new Map();
    let totalBytes = 0;
    for (const assetName of PUBLIC_ASSET_NAMES) {
      const filePath = path.join(publicDir, assetName);
      const initialStat = await fsp.lstat(filePath);
      if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
        throw httpError(500, `静态资源 ${assetName} 不是普通文件。`);
      }
      const initialRealPath = await fsp.realpath(filePath);
      if (!isPathWithin(realPublicDir, initialRealPath)) {
        throw httpError(500, `静态资源 ${assetName} 超出允许范围。`);
      }

      const fileHandle = await fsp.open(initialRealPath, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NONBLOCK);
      try {
        const [openedStat, currentRealPublicDir, currentRealPath, currentPathStat] = await Promise.all([
          fileHandle.stat({ bigint: true }),
          fsp.realpath(publicDir),
          fsp.realpath(filePath),
          fsp.stat(filePath, { bigint: true })
        ]);
        if (!openedStat.isFile()
          || !currentPathStat.isFile()
          || path.relative(realPublicDir, currentRealPublicDir) !== ''
          || !isPathWithin(realPublicDir, currentRealPath)
          || !hasSameFileIdentity(openedStat, currentPathStat)) {
          throw httpError(500, `静态资源 ${assetName} 在加载期间发生变化。`);
        }
        const assetBytes = Number(openedStat.size);
        if (!Number.isSafeInteger(assetBytes) || assetBytes < 0 || assetBytes > MAX_PUBLIC_ASSET_BYTES) {
          throw httpError(500, `静态资源 ${assetName} 超过大小限制。`);
        }
        totalBytes += assetBytes;
        if (totalBytes > MAX_PUBLIC_ASSET_TOTAL_BYTES) {
          throw httpError(500, '静态资源总大小超过限制。');
        }

        await beforeStaticRead?.({ allowedBase: publicDir, filePath, realBase: realPublicDir, realFile: currentRealPath });
        const data = await readExactPublicAsset(fileHandle, assetBytes, assetName);
        const afterStat = await fileHandle.stat({ bigint: true });
        if (!hasSameFileIdentity(openedStat, afterStat)
          || openedStat.size !== afterStat.size
          || openedStat.mtimeNs !== afterStat.mtimeNs
          || openedStat.ctimeNs !== afterStat.ctimeNs
          || data.length !== assetBytes) {
          throw httpError(500, `静态资源 ${assetName} 在读取期间发生变化。`);
        }
        const extension = path.extname(assetName).toLowerCase();
        assets.set(assetName, {
          contentType: MIME_TYPES[extension] || 'application/octet-stream',
          data
        });
      } finally {
        await fileHandle.close();
      }
    }
    return assets;
  }

  function preparePublicAssets() {
    if (!publicAssetsPromise) {
      publicAssetsPromise = loadPublicAssets();
    }
    return publicAssetsPromise;
  }

  async function ensureDirectories() {
    await Promise.all([
      ensureDirectoryWithinRoot(rootDir, publicDir, '静态资源目录'),
      ensureDirectoryWithinRoot(rootDir, capturesDir, '截图目录'),
      ensureDirectoryWithinRoot(rootDir, logsDir, '日志目录'),
      ensureDirectoryWithinRoot(rootDir, tmpDir, '临时目录')
    ]);
  }

  async function cleanupExpiredLogs() {
    const retentionMs = Number(config.logRetentionMs) || 0;
    if (retentionMs <= 0) {
      return { cleared: 0, removed: 0 };
    }
    await ensureDirectoryWithinRoot(rootDir, logsDir, '日志目录');
    const cutoff = Date.now() - retentionMs;
    let cleared = 0;
    const realRoot = await fsp.realpath(rootDir);
    const entries = await fsp.readdir(logsDir, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !INTERNAL_FAILURE_LOG_PATTERN.test(entry.name)) {
        continue;
      }
      const logPath = path.join(logsDir, entry.name);
      let fileHandle;
      try {
        const initialStat = await fsp.lstat(logPath);
        if (initialStat.isSymbolicLink() || !initialStat.isFile() || initialStat.mtimeMs >= cutoff) {
          continue;
        }
        fileHandle = await fsp.open(logPath, FS_CONSTANTS.O_RDWR | FS_CONSTANTS.O_NONBLOCK);
        const [logsStat, realLogsDir, realLogPath, openedStat] = await Promise.all([
          fsp.lstat(logsDir),
          fsp.realpath(logsDir),
          fsp.realpath(logPath),
          fileHandle.stat({ bigint: true })
        ]);
        const pathStat = await fsp.stat(realLogPath, { bigint: true });
        if (logsStat.isSymbolicLink()
          || !logsStat.isDirectory()
          || !isPathWithin(realRoot, realLogsDir)
          || !isPathWithin(realLogsDir, realLogPath)
          || !openedStat.isFile()
          || !pathStat.isFile()
          || !hasSameFileIdentity(openedStat, pathStat)) {
          throw httpError(500, '过期日志在清理前发生变化。');
        }
        if (Number(openedStat.mtimeMs) < cutoff) {
          await beforeLogRetentionClear?.({ logPath, logsDir });
          await fileHandle.truncate(0);
          await fileHandle.chmod(0o600);
          await fileHandle.sync();
          cleared += 1;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          safeLog(logger, 'warn', 'Failed to inspect or clear expired log:', error);
        }
      } finally {
        await fileHandle?.close().catch(() => {});
      }
    }
    return { cleared, removed: 0 };
  }

  const mysqlService = options.mysqlService || createMysqlService({
    state,
    normalizeRows,
    defaultPreviewLimit: DEFAULT_PREVIEW_LIMIT,
    buildDetectedFields,
    buildFieldCandidates,
    buildTemplateAvailability,
    buildTemplateQuery,
    queryTimeoutMs: config.queryTimeoutMs
  });
  const captureService = options.captureService || createCaptureService({
    rootDir,
    capturesDir,
    tmpDir,
    maxCaptureRows: MAX_CAPTURE_ROWS,
    maxCaptureWidth: 2200,
    maxCaptureHeight: 9000,
    minCaptureWidth: 420,
    minCaptureHeight: 220,
    sanitizeFileName,
    resolveCaptureFileName,
    ensureDirectories
  });

  let failureLogQueue = Promise.resolve();
  let failureLogSequence = 0;

  function boundedLogValue(value, maxCharacters) {
    return String(value || '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu, ' ')
      .trim()
      .slice(0, maxCharacters);
  }

  function fitLogToByteLimit(value, byteLimit) {
    if (Buffer.byteLength(value, 'utf8') <= byteLimit) {
      return value;
    }
    const suffix = '\n[log truncated]\n';
    const suffixBytes = Buffer.byteLength(suffix, 'utf8');
    let prefix = Buffer.from(value, 'utf8')
      .subarray(0, Math.max(0, byteLimit - suffixBytes))
      .toString('utf8')
      .replace(/\uFFFD$/u, '');
    while (Buffer.byteLength(prefix + suffix, 'utf8') > byteLimit && prefix) {
      prefix = prefix.slice(0, -1);
    }
    return prefix + suffix;
  }

  async function writeTaskFailureLogWithinBudget(context, error, reason) {
    await ensureDirectories();
    const safeTaskName = sanitizeFileName(context.taskName || context.table || 'task-error');
    const lines = [
      `Timestamp: ${new Date().toISOString()}`,
      `Reason: ${JSON.stringify(boundedLogValue(reason, 512))}`,
      `Database: ${JSON.stringify(boundedLogValue(context.database, 128))}`,
      `Table: ${JSON.stringify(boundedLogValue(context.table, 128))}`,
      `Task Name: ${JSON.stringify(boundedLogValue(context.taskName, 128))}`,
      `Template: ${JSON.stringify(boundedLogValue(context.templateName, 128))}`,
      `Error Code: ${JSON.stringify(boundedLogValue(error?.code, 128))}`,
      `Error Message: ${JSON.stringify(boundedLogValue(error?.message, 4_096))}`,
      `SQL: ${JSON.stringify(boundedLogValue(context.sql, 8_192))}`
    ];
    if (error?.stack) {
      lines.push(`Stack: ${JSON.stringify(boundedLogValue(error.stack, 8_192))}`);
    }
    const contents = fitLogToByteLimit(`${lines.join('\n')}\n`, maxFailureLogFileBytes);
    const contentsBuffer = Buffer.from(contents, 'utf8');
    const contentsBytes = Buffer.byteLength(contents, 'utf8');
    const entries = await fsp.readdir(logsDir, { withFileTypes: true });
    const logEntries = entries.filter((entry) => entry.isFile() && INTERNAL_FAILURE_LOG_PATTERN.test(entry.name));
    let existingBytes = 0;
    let reusableLogPath = '';
    for (const entry of logEntries) {
      const stat = await fsp.stat(path.join(logsDir, entry.name));
      existingBytes += stat.size;
      if (!reusableLogPath && stat.size === 0) {
        reusableLogPath = path.join(logsDir, entry.name);
      }
      if (existingBytes + contentsBytes > maxFailureLogTotalBytes) {
        return null;
      }
    }
    if (logEntries.length >= maxFailureLogFiles && !reusableLogPath) {
      return null;
    }
    if (existingBytes + contentsBytes > maxFailureLogTotalBytes) {
      return null;
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const reuseExistingSlot = attempt === 0 && Boolean(reusableLogPath);
      if (!reuseExistingSlot) {
        failureLogSequence = (failureLogSequence + 1) % 1_000_000;
      }
      const logPath = reuseExistingSlot
        ? reusableLogPath
        : path.join(logsDir, `tableshot-${nowStamp()}-${failureLogSequence}-${safeTaskName}.log`);
      let fileHandle;
      try {
        fileHandle = reuseExistingSlot
          ? await fsp.open(logPath, FS_CONSTANTS.O_RDWR | FS_CONSTANTS.O_NONBLOCK)
          : await fsp.open(logPath, 'wx', 0o600);
        const [realRoot, logsStat, realLogsDir, realLogPath, openedStat] = await Promise.all([
          fsp.realpath(rootDir),
          fsp.lstat(logsDir),
          fsp.realpath(logsDir),
          fsp.realpath(logPath),
          fileHandle.stat({ bigint: true })
        ]);
        if (logsStat.isSymbolicLink()
          || !logsStat.isDirectory()
          || !isPathWithin(realRoot, realLogsDir)
          || !isPathWithin(realLogsDir, realLogPath)) {
          throw httpError(500, '日志路径在写入前超出允许范围。');
        }
        const pathStat = await fsp.stat(realLogPath, { bigint: true });
        if (!openedStat.isFile()
          || !pathStat.isFile()
          || !hasSameFileIdentity(openedStat, pathStat)
          || (reuseExistingSlot && openedStat.size !== 0n)) {
          throw httpError(500, '日志文件在写入前发生变化。');
        }
        await fileHandle.chmod(0o600);
        await beforeFailureLogWrite?.({ logPath, logsDir });
        await fileHandle.truncate(0);
        let writeOffset = 0;
        while (writeOffset < contentsBuffer.length) {
          const { bytesWritten } = await fileHandle.write(
            contentsBuffer,
            writeOffset,
            contentsBuffer.length - writeOffset,
            writeOffset
          );
          if (bytesWritten <= 0) {
            throw httpError(500, '日志文件写入未取得进展。');
          }
          writeOffset += bytesWritten;
        }
        await fileHandle.sync();
        const writtenStat = await fileHandle.stat({ bigint: true });
        if (!hasSameFileIdentity(openedStat, writtenStat) || writtenStat.size !== BigInt(contentsBytes)) {
          throw httpError(500, '日志文件写入后超出预算或发生变化。');
        }

        const stablePath = await Promise.all([
          fsp.lstat(logsDir),
          fsp.realpath(logsDir),
          fsp.realpath(logPath),
          fsp.stat(logPath, { bigint: true })
        ]).then(([currentLogsStat, currentRealLogsDir, currentRealLogPath, currentPathStat]) => (
          !currentLogsStat.isSymbolicLink()
          && currentLogsStat.isDirectory()
          && isPathWithin(realRoot, currentRealLogsDir)
          && isPathWithin(currentRealLogsDir, currentRealLogPath)
          && hasSameFileIdentity(openedStat, currentPathStat)
          && currentPathStat.size === BigInt(contentsBytes)
        )).catch(() => false);
        return stablePath ? logPath : null;
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') {
          throw writeError;
        }
      } finally {
        await fileHandle?.close().catch(() => {});
      }
    }
    throw new Error('无法分配唯一的任务失败日志文件名。');
  }

  function writeTaskFailureLog(context, error, reason) {
    const pending = failureLogQueue.then(() => writeTaskFailureLogWithinBudget(context, error, reason));
    failureLogQueue = pending.catch(() => {});
    return pending;
  }

  const failureLogWriter = options.failureLogWriter || writeTaskFailureLog;

  async function annotateTaskError(inputError, context) {
    const error = inputError instanceof Error ? inputError : new Error(String(inputError || 'Unknown error'));
    if (error.annotatedTaskError) {
      return error;
    }
    error.annotatedTaskError = true;
    error.reason = guessTaskFailureReason(error, context);
    if (Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500) {
      return error;
    }
    try {
      const absoluteLogPath = await failureLogWriter(context, error, error.reason);
      if (absoluteLogPath) {
        error.logPath = toRepoRelativePath(rootDir, absoluteLogPath);
      }
    } catch (logError) {
      safeLog(logger, 'error', 'Failed to write task error log:', logError);
    }
    return error;
  }

  function toPublicArtifact(artifact, result) {
    if (!artifact) {
      return null;
    }
    const queryTruncated = Object.prototype.hasOwnProperty.call(artifact, 'queryTruncated')
      ? Boolean(artifact.queryTruncated)
      : Boolean(result?.truncated);
    const captureTruncated = Object.prototype.hasOwnProperty.call(artifact, 'captureTruncated')
      ? Boolean(artifact.captureTruncated)
      : Boolean(artifact.truncated);
    return {
      runId: artifact.runId || '',
      folderPath: toRepoRelativePath(rootDir, artifact.folderPath),
      imageFolderPath: toRepoRelativePath(rootDir, artifact.imageFolderPath),
      imagePath: toRepoRelativePath(rootDir, artifact.imagePath),
      truncated: Boolean(artifact.truncated || queryTruncated || captureTruncated),
      queryTruncated,
      captureTruncated,
      returnedRowCount: Number.isFinite(Number(artifact.returnedRowCount))
        ? Number(artifact.returnedRowCount)
        : Array.isArray(result?.rows) ? result.rows.length : 0,
      capturedRowCount: Number.isFinite(Number(artifact.capturedRowCount)) ? Number(artifact.capturedRowCount) : 0,
      totalRowCount: Math.max(
        Number.isFinite(Number(artifact.totalRowCount)) ? Number(artifact.totalRowCount) : 0,
        Number.isFinite(Number(result?.totalRowCount)) ? Number(result.totalRowCount) : 0
      )
    };
  }

  async function servePublicAsset(res, requestedName) {
    const resolvedPath = resolveStaticPath(publicDir, requestedName);
    const relativeName = path.relative(path.resolve(publicDir), resolvedPath).split(path.sep).join('/');
    const assets = await preparePublicAssets();
    const asset = assets.get(relativeName);
    if (!asset) {
      throw httpError(404, '资源不存在。');
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': asset.contentType,
      'Content-Length': asset.data.length,
      'Cache-Control': 'no-store'
    });
    res.end(asset.data);
  }

  async function handleConnect(req, res) {
    const payload = await readJsonBody(req);
    const host = String(payload.host || '').trim() || '127.0.0.1';
    const requestedPort = payload.port === undefined || payload.port === '' ? 3306 : Number(payload.port);
    const user = String(payload.user || '').trim();
    const password = String(payload.password || '');
    if (!host || host.length > 255 || /[\u0000-\u001f\u007f]/u.test(host)) {
      throw httpError(400, '数据库主机格式非法。');
    }
    if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
      throw httpError(400, '数据库端口格式非法。');
    }
    if (!user || user.length > 128 || /[\u0000-\u001f\u007f]/u.test(user)) {
      throw httpError(400, '用户名不能为空或格式非法。');
    }
    if (password.length > 4096) {
      throw httpError(400, '密码长度超出限制。');
    }

    const connectionConfig = {
      host,
      port: requestedPort,
      user,
      password,
      connectTimeout: 8_000,
      multipleStatements: false
    };
    if (config.mysqlSslCaPath) {
      connectionConfig.ssl = {
        ca: await fsp.readFile(path.resolve(config.mysqlSslCaPath)),
        rejectUnauthorized: config.mysqlSslRejectUnauthorized !== false
      };
    }

    const { version, databases } = await mysqlService.replaceConnection(connectionConfig);
    jsonResponse(res, 200, {
      ok: true,
      version,
      databases,
      browser: captureService.findBrowser() ? 'available' : 'missing',
      connection: { host, port: requestedPort, user, tls: Boolean(connectionConfig.ssl) }
    });
  }

  async function handleStatus(_req, res) {
    const status = await mysqlService.getStatus();
    jsonResponse(res, 200, {
      ...status,
      browser: captureService.findBrowser() ? 'available' : 'missing'
    });
  }

  async function handleCaptureWarmup(req, res) {
    const payload = await readJsonBody(req);
    requireConnection();
    if (payload.keys !== undefined && !Array.isArray(payload.keys)) {
      throw httpError(400, 'keys 必须是数组。');
    }
    const rawKeys = payload.keys || [];
    if (rawKeys.length > MAX_WARMUP_KEYS) {
      throw httpError(400, `截图预热 key 不能超过 ${MAX_WARMUP_KEYS} 个。`);
    }
    const keys = rawKeys.map(normalizeCaptureProfileKey).filter(Boolean);
    const uniqueKeys = [...new Set(keys)];
    await mapWithConcurrency(uniqueKeys, MAX_WARMUP_CONCURRENCY, (key) => captureService.warmupCaptureSession(key));
    jsonResponse(res, 200, { ok: true, warmed: uniqueKeys.length });
  }

  async function handleAnalyzeTable(req, res) {
    const payload = await readJsonBody(req);
    const database = normalizeStructuredName(payload.database, '数据库名称');
    const table = normalizeStructuredName(payload.table, '表名称');
    const taskName = `analyze-${sanitizeFileName(table)}`;
    if (payload.confirm !== true) {
      throw httpError(400, 'ANALYZE TABLE 需要显式 confirm: true。');
    }
    requireConnection();
    try {
      const rows = await mysqlService.analyzeTable(database, table);
      const errorRow = rows.find((row) => String(row?.Msg_type || row?.msg_type || '').toLowerCase() === 'error');
      if (errorRow) {
        throw new Error(String(errorRow.Msg_text || errorRow.msg_text || 'ANALYZE TABLE 返回错误。').trim());
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
        sql: `ANALYZE TABLE ${mysql.escapeId(database, true)}.${mysql.escapeId(table, true)}`
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
        throw httpError(404, '目标目录还不存在，可能是任务尚未生成输出。');
      }
      throw error;
    }
    if (!stat.isDirectory()) {
      throw httpError(400, '目标路径不是一个目录。');
    }
    await captureService.openFolder(absolute);
    jsonResponse(res, 200, { ok: true, path: toRepoRelativePath(rootDir, absolute) });
  }

  async function handleQueryPreview(req, res) {
    const payload = await readJsonBody(req);
    const structured = normalizeStructuredQuery(payload);
    requireConnection();
    const preview = await mysqlService.previewTemplateQuery(structured.database, structured.request);
    jsonResponse(res, 200, { ok: true, sql: preview.sql, template: preview.template });
  }

  async function handleQuery(req, res) {
    const payload = await readJsonBody(req);
    const structured = normalizeStructuredQuery(payload);
    requireConnection();
    const runId = normalizeRunId(payload.runId);
    const captureProfileKey = normalizeCaptureProfileKey(payload.captureProfileKey);
    const taskName = sanitizeFileName(payload.taskName || `${structured.request.table}-capture`);
    let execution;
    try {
      execution = await mysqlService.executeTemplateQuery(structured.database, structured.request);
      let artifact = null;
      if (payload.capture) {
        artifact = toPublicArtifact(await captureService.createArtifact({
          runId,
          taskName,
          templateId: structured.request.templateId,
          imageName: execution.templateName,
          database: structured.database,
          table: structured.request.table,
          tableComment: execution.tableComment,
          sql: execution.sql,
          result: execution.result,
          captureProfileKey,
          captureOptions: execution.captureOptions
        }), execution.result);
      }
      jsonResponse(res, 200, { ok: true, sql: execution.sql, result: execution.result, artifact });
    } catch (error) {
      await annotateTaskError(error, {
        database: structured.database,
        table: structured.request.table,
        taskName,
        templateName: execution?.templateName || structured.request.templateId,
        sql: execution?.sql || ''
      });
      throw error;
    }
  }

  function requireConnection() {
    mysqlService.assertConnected();
  }

  async function routeApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return handleStatus(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/templates') {
      return jsonResponse(res, 200, { ok: true, templates: listPublicTemplates() });
    }
    if (req.method === 'POST' && url.pathname === '/api/connect') {
      return handleConnect(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/automation/run') {
      throw httpError(410, '旧自动化接口已停用，请逐项调用结构化 /api/query。');
    }
    if (req.method === 'GET' && url.pathname === '/api/databases') {
      requireConnection();
      return jsonResponse(res, 200, { ok: true, databases: await mysqlService.listDatabases() });
    }
    if (req.method === 'GET' && url.pathname === '/api/tables') {
      requireConnection();
      const database = String(url.searchParams.get('database') || '').trim();
      if (!database) {
        throw httpError(400, '缺少数据库名称。');
      }
      return jsonResponse(res, 200, { ok: true, tables: await mysqlService.listTables(database) });
    }
    if (req.method === 'GET' && url.pathname === '/api/columns') {
      requireConnection();
      const database = String(url.searchParams.get('database') || '').trim();
      const table = String(url.searchParams.get('table') || '').trim();
      if (!database || !table) {
        throw httpError(400, '缺少数据库或表名。');
      }
      return jsonResponse(res, 200, { ok: true, columns: await mysqlService.listColumns(database, table) });
    }
    if (req.method === 'GET' && url.pathname === '/api/preview') {
      requireConnection();
      const database = String(url.searchParams.get('database') || '').trim();
      const table = String(url.searchParams.get('table') || '').trim();
      const limit = String(url.searchParams.get('limit') || '').trim();
      if (!database || !table) {
        throw httpError(400, '缺少数据库或表名。');
      }
      return jsonResponse(res, 200, { ok: true, result: await mysqlService.previewTable(database, table, limit) });
    }
    if (req.method === 'POST' && url.pathname === '/api/capture/warmup') {
      return handleCaptureWarmup(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/analyze-table') {
      return handleAnalyzeTable(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      return handleOpenFolder(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/query/preview') {
      return handleQueryPreview(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/query') {
      return handleQuery(req, res);
    }
    throw httpError(404, 'API 路径不存在。');
  }

  async function routeStatic(_req, res, url) {
    if (url.pathname === '/' || url.pathname === '/login') {
      return servePublicAsset(res, 'login.html');
    }
    if (url.pathname === '/app') {
      return servePublicAsset(res, 'index.html');
    }
    if (url.pathname.startsWith('/captures/')) {
      throw httpError(404, '截图文件不会通过 HTTP 提供，请使用“打开目录”查看本地产物。');
    }
    const relativePath = url.pathname.replace(/^\/+/, '');
    return servePublicAsset(res, relativePath);
  }

  let activeApiRequests = 0;
  const maxConcurrentApiRequests = Math.max(
    1,
    Math.min(64, Number(options.maxConcurrentApiRequests) || MAX_CONCURRENT_API_REQUESTS)
  );

  async function requestListener(req, res) {
    let isApiRequest = false;
    let acquiredApiSlot = false;
    try {
      const url = parseRequestUrl(req);
      isApiRequest = url.pathname.startsWith('/api/');
      if (isApiRequest) {
        if (req.method === 'POST') {
          assertJsonContentType(req);
        }
        if (activeApiRequests >= maxConcurrentApiRequests) {
          throw httpError(503, '服务器正忙，请稍后重试。', { expose: true });
        }
        activeApiRequests += 1;
        acquiredApiSlot = true;
        await routeApi(req, res, url);
      } else {
        await routeStatic(req, res, url);
      }
    } catch (inputError) {
      const error = inputError instanceof Error ? inputError : new Error(String(inputError || 'Unknown error'));
      const statusCode = Number.isInteger(error.statusCode)
        ? Math.max(400, Math.min(599, error.statusCode))
        : error.code === 'ENOENT' ? 404 : 500;
      if (statusCode >= 500) {
        safeLog(logger, 'error', 'Request failed:', error);
      }
      const explicitHttpError = Number.isInteger(error.statusCode);
      const canExpose = error.expose === true
        || (explicitHttpError && statusCode < 500 && error.expose !== false);
      const message = canExpose
        ? error.message
        : statusCode === 404 ? '资源不存在。' : '服务器发生内部错误。';
      jsonResponse(res, statusCode, {
        ok: false,
        message,
        reason: error.reason || null,
        logPath: error.logPath || null
      });
    } finally {
      if (acquiredApiSlot && activeApiRequests > 0) {
        activeApiRequests -= 1;
      }
    }
  }

  let shutdownPromise;
  function shutdown() {
    if (!shutdownPromise) {
      shutdownPromise = Promise.allSettled([
        Promise.resolve().then(() => mysqlService.closeConnectionPool()),
        Promise.resolve().then(() => captureService.shutdownBrowserSessions())
      ]).then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            safeLog(logger, 'error', 'Shutdown cleanup failed:', result.reason);
          }
        }
      });
    }
    return shutdownPromise;
  }

  return {
    captureService,
    cleanupExpiredLogs,
    config,
    ensureDirectories,
    mysqlService,
    preparePublicAssets,
    requestListener,
    shutdown,
    state,
    tmpDir
  };
}

async function startServer(options = {}) {
  const config = { ...(options.config || readServerConfig(options.env)) };
  if (!LOOPBACK_BIND_HOSTS.has(normalizeLoopbackHostname(config.host))) {
    throw httpError(500, '服务只能绑定数值 loopback 地址。', { expose: true });
  }
  config.host = normalizeLoopbackHostname(config.host);
  const application = options.application || createApplication({ ...options, config });
  await application.ensureDirectories();
  if (typeof application.preparePublicAssets === 'function') {
    await application.preparePublicAssets();
  }
  if (typeof application.cleanupExpiredLogs === 'function') {
    await application.cleanupExpiredLogs();
  }

  const server = http.createServer(application.requestListener);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;

  let closed = false;
  const signalHandlers = new Map();
  async function shutdown() {
    if (closed) {
      return application.shutdown();
    }
    closed = true;
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await application.shutdown();
  }
  server.application = application;
  server.shutdown = shutdown;

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, config.host);
    });
  } catch (error) {
    await application.shutdown();
    throw error;
  }

  server.on('error', (error) => safeLog(options.logger || console, 'error', 'HTTP server error:', error));
  server.once('close', () => {
    application.shutdown().catch((error) => safeLog(options.logger || console, 'error', 'Close cleanup failed:', error));
  });

  const installSignalHandlers = options.installSignalHandlers ?? require.main === module;
  if (installSignalHandlers) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        shutdown().catch((error) => {
          safeLog(options.logger || console, 'error', `Shutdown after ${signal} failed:`, error);
          process.exitCode = 1;
        });
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  safeLog(options.logger || console, 'info', `MySQL capture tool is running at http://${config.host}:${server.address().port}`);
  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    safeLog(console, 'error', error);
    process.exitCode = 1;
  });
}

module.exports = {
  SECURITY_HEADERS,
  createApplication,
  readServerConfig,
  startServer
};
