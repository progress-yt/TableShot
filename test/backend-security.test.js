const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const test = require('node:test');

const templates = require('../lib/templates');
const serverModule = require('../server');

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080
]);

const SAMPLE_COLUMNS = [
  { columnName: 'id', columnType: 'bigint', columnComment: '主键' },
  { columnName: 'created_at', columnType: 'datetime', columnComment: '创建时间' },
  { columnName: 'region_name', columnType: 'varchar(64)', columnComment: '区域' }
];

function makeMysqlService(overrides = {}) {
  return {
    assertConnected() {},
    async getStatus() {
      return { connected: true, health: 'healthy', connection: { host: '127.0.0.1', port: 3306, user: 'tester' } };
    },
    async executeTemplateQuery(database, request) {
      return {
        sql: `SELECT COUNT(1) FROM \`${database}\`.\`${request.table}\``,
        result: { columns: ['count'], rows: [{ count: 1 }] },
        tableComment: '测试表'
      };
    },
    async analyzeTable() {
      return [];
    },
    async replaceConnection() {
      return { version: '8.4.0', databases: ['analytics'] };
    },
    async closeConnectionPool() {},
    ...overrides
  };
}

function makeCaptureService(overrides = {}) {
  return {
    findBrowser() {
      return null;
    },
    async warmupCaptureSession() {},
    async createArtifact() {
      return null;
    },
    async shutdownBrowserSessions() {},
    resolveAllowedFolderPath() {
      return path.join(__dirname, '..', 'public');
    },
    async openFolder() {},
    ...overrides
  };
}

async function listenOnFetchSafePort(server) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    if (!FETCH_FORBIDDEN_PORTS.has(server.address().port)) {
      return;
    }
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error('unable to allocate a fetch-safe test port');
}

async function startTestApplication(options = {}) {
  assert.equal(typeof serverModule.createApplication, 'function', 'server.createApplication must be exported');
  const application = serverModule.createApplication({
    config: options.config || {
      host: '127.0.0.1',
      port: 0,
      apiToken: '',
      requireAuth: false
    },
    mysqlService: options.mysqlService || makeMysqlService(),
    captureService: options.captureService || makeCaptureService(),
    failureLogWriter: options.failureLogWriter || (async () => null),
    logger: options.logger || { error() {}, warn() {}, info() {} },
    maxConcurrentApiRequests: options.maxConcurrentApiRequests
  });
  const server = http.createServer(application.requestListener);
  await listenOnFetchSafePort(server);
  const address = server.address();
  return {
    application,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await application.shutdown();
    }
  };
}

async function rawHttp(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

test('arbitrary SQL validators and executors are not exported', () => {
  assert.equal(templates.assertReadOnlySql, undefined);
  assert.equal(templates.assertAllowedQuery, undefined);
  assert.equal(templates.TEMPLATE_REGISTRY, undefined);
  assert.equal(templates.quoteIdentifier, undefined);
  assert.equal(serverModule.assertReadOnlySql, undefined);
});

test('server-side template registry builds parameterized SQL from structured input', () => {
  assert.equal(typeof templates.buildTemplateQuery, 'function');
  const query = templates.buildTemplateQuery({
    templateId: 'total-rows',
    database: 'analytics',
    table: 'orders',
    tableComment: "O'Reilly orders",
    columns: SAMPLE_COLUMNS,
    fields: {},
    sql: 'SELECT SLEEP(60)'
  });

  assert.match(query.sql, /SELECT\s+\?\s+AS/u);
  assert.match(query.sql, /`analytics`\.`orders`/u);
  assert.deepEqual(query.params, ["O'Reilly orders"]);
  assert.doesNotMatch(query.sql, /SLEEP|O'Reilly/iu);
});

test('template lookup rejects inherited object keys as controlled client errors', () => {
  for (const templateId of ['__proto__', 'constructor', 'toString']) {
    assert.throws(
      () => templates.buildTemplateQuery({
        templateId,
        database: 'analytics',
        table: 'orders',
        columns: SAMPLE_COLUMNS,
        fields: {}
      }),
      (error) => error?.statusCode === 400 && /未知|不受支持/.test(error.message)
    );
    assert.equal(templates.resolveCaptureFileName(templateId, 'fallback'), 'fallback');
  }
});

test('template registry validates selected fields against real column metadata', () => {
  assert.equal(typeof templates.buildTemplateQuery, 'function');
  assert.throws(
    () => templates.buildTemplateQuery({
      templateId: 'time-range',
      database: 'analytics',
      table: 'orders',
      columns: SAMPLE_COLUMNS,
      fields: { timeField: 'created_at`), SLEEP(60), (`id' }
    }),
    /字段|column/i
  );

  const query = templates.buildTemplateQuery({
    templateId: 'region-distribution',
    database: 'analytics',
    table: 'orders',
    columns: SAMPLE_COLUMNS,
    fields: { regionField: 'region_name' }
  });
  assert.match(query.sql, /DISTINCT LEFT\(CAST\(`region_name` AS CHAR\), 512\) AS `region_name`/u);
  assert.match(query.sql, /LIMIT 501$/u);
});

test('public template metadata does not expose executable builders', () => {
  assert.equal(typeof templates.listPublicTemplates, 'function');
  const publicTemplates = templates.listPublicTemplates();
  assert.equal(publicTemplates.length, 5);
  assert.deepEqual(Object.keys(publicTemplates[0]), ['id', 'name', 'description', 'fieldRole', 'sideEffects']);
  assert.equal(publicTemplates.some((template) => Object.hasOwn(template, 'build')), false);
});

test('server configuration is restricted to loopback even when remote flags are present', () => {
  assert.equal(typeof serverModule.readServerConfig, 'function');
  assert.throws(
    () => serverModule.readServerConfig({ HOST: '0.0.0.0', PORT: '3811' }),
    /remote|远程|loopback|本机/i
  );
  assert.throws(
    () => serverModule.readServerConfig({
      HOST: '0.0.0.0',
      TABLESHOT_ALLOW_REMOTE: 'true',
      TABLESHOT_API_TOKEN: '0123456789abcdef0123456789abcdef'
    }),
    /remote|远程|loopback|本机/i
  );

  assert.equal(serverModule.readServerConfig({ HOST: '127.0.0.1' }).host, '127.0.0.1');
  assert.equal(serverModule.readServerConfig({ HOST: '::1' }).host, '::1');
  assert.equal(serverModule.readServerConfig({ HOST: '[::1]' }).host, '::1');
  assert.throws(
    () => serverModule.readServerConfig({ HOST: 'localhost' }),
    /数值|loopback|127\.0\.0\.1|::1/i
  );
  assert.equal(serverModule.readServerConfig({ HOST: '127.0.0.1' }).logRetentionMs, 0);
  assert.equal(serverModule.readServerConfig({ HOST: '127.0.0.1', LOG_RETENTION_MS: '60000' }).logRetentionMs, 60000);
  assert.throws(
    () => serverModule.readServerConfig({ HOST: '127.0.0.1', LOG_RETENTION_MS: '-1' }),
    /LOG_RETENTION_MS/
  );
  assert.equal(serverModule.readServerConfig({
    HOST: '127.0.0.1', MYSQL_SSL_REJECT_UNAUTHORIZED: 'false'
  }).mysqlSslRejectUnauthorized, false);
  assert.throws(
    () => serverModule.readServerConfig({ HOST: '127.0.0.1', MYSQL_SSL_REJECT_UNAUTHORIZED: 'maybe' }),
    /布尔环境变量/
  );
});

test('invalid JSON is a controlled 400 response', async (t) => {
  const fixture = await startTestApplication();
  t.after(() => fixture.close());

  const response = await fetch(`${fixture.baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{broken'
  });
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.ok, false);
  assert.match(payload.message, /JSON|请求体/);
});

test('API writes require application/json and all responses carry security headers', async (t) => {
  const fixture = await startTestApplication();
  t.after(() => fixture.close());

  const unsupported = await fetch(`${fixture.baseUrl}/api/query`, {
    method: 'POST',
    body: JSON.stringify({ database: 'analytics', table: 'orders', templateId: 'total-rows' })
  });
  assert.equal(unsupported.status, 415);

  const apiResponse = await fetch(`${fixture.baseUrl}/api/status`);
  assert.equal(apiResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(apiResponse.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(apiResponse.headers.get('x-frame-options'), 'DENY');
  assert.equal(apiResponse.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(apiResponse.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(apiResponse.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.match(apiResponse.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);

  const pageResponse = await fetch(`${fixture.baseUrl}/`);
  assert.equal(pageResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.match(pageResponse.headers.get('content-security-policy') || '', /default-src 'self'/);

  const missingResponse = await fetch(`${fixture.baseUrl}/definitely-missing.txt`);
  const missingPayload = await missingResponse.json();
  assert.equal(missingResponse.status, 404);
  assert.equal(missingPayload.message, '资源不存在。');
  assert.doesNotMatch(JSON.stringify(missingPayload), /TableShot|public|ENOENT/i);
});

test('template catalog and SQL preview are server-owned and preview does not execute a template', async (t) => {
  let previewCalls = 0;
  let executionCalls = 0;
  const fixture = await startTestApplication({
    mysqlService: makeMysqlService({
      async previewTemplateQuery(database, request) {
        previewCalls += 1;
        return {
          sql: `SELECT COUNT(1) FROM \`${database}\`.\`${request.table}\``,
          template: { id: request.templateId, name: '查询总行数' }
        };
      },
      async executeTemplateQuery() {
        executionCalls += 1;
        throw new Error('preview must not execute');
      }
    })
  });
  t.after(() => fixture.close());

  const templatesResponse = await fetch(`${fixture.baseUrl}/api/templates`);
  const templatePayload = await templatesResponse.json();
  assert.equal(templatesResponse.status, 200);
  assert.equal(templatePayload.templates.length, 5);
  assert.equal(Object.hasOwn(templatePayload.templates[0], 'build'), false);

  const previewResponse = await fetch(`${fixture.baseUrl}/api/query/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      database: 'analytics',
      table: 'orders',
      templateId: 'total-rows',
      fields: {}
    })
  });
  const previewPayload = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  assert.equal(previewPayload.ok, true);
  assert.equal(previewPayload.template.id, 'total-rows');
  assert.equal(previewCalls, 1);
  assert.equal(executionCalls, 0);
});

test('query endpoint rejects client SQL and accepts structured template requests', async (t) => {
  const calls = [];
  const fixture = await startTestApplication({
    mysqlService: makeMysqlService({
      async executeTemplateQuery(database, request) {
        calls.push({ database, request });
        return {
          sql: 'SELECT COUNT(1) AS total FROM `analytics`.`orders`',
          result: { columns: ['total'], rows: [{ total: 1 }] },
          tableComment: '订单'
        };
      }
    })
  });
  t.after(() => fixture.close());

  const rejected = await fetch(`${fixture.baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      database: 'analytics',
      table: 'orders',
      templateId: 'total-rows',
      sql: 'SELECT SLEEP(60)'
    })
  });
  assert.equal(rejected.status, 400);
  assert.equal(calls.length, 0);

  const rejectedCaptureOptions = await fetch(`${fixture.baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      database: 'analytics',
      table: 'orders',
      templateId: 'total-rows',
      captureOptions: { hideSql: false }
    })
  });
  assert.equal(rejectedCaptureOptions.status, 400);
  assert.equal(calls.length, 0);

  const accepted = await fetch(`${fixture.baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      database: 'analytics',
      table: 'orders',
      templateId: 'total-rows',
      fields: {},
      capture: false
    })
  });
  const payload = await accepted.json();
  assert.equal(accepted.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0].request, 'sql'), false);
  assert.equal(payload.sql, 'SELECT COUNT(1) AS total FROM `analytics`.`orders`');
});

test('query validates runId and forwards a safe runId to capture', async (t) => {
  const captureCalls = [];
  const fixture = await startTestApplication({
    captureService: makeCaptureService({
      async createArtifact(input) {
        captureCalls.push(input);
        return {
          runId: input.runId,
          folderPath: 'captures/run-safe_123',
          imageFolderPath: 'captures/run-safe_123/orders',
          imagePath: 'captures/run-safe_123/orders.png',
          imageUrl: '/captures/run-safe_123/orders.png',
          truncated: true,
          queryTruncated: false,
          captureTruncated: true,
          returnedRowCount: 150,
          capturedRowCount: 150,
          totalRowCount: 501
        };
      }
    })
  });
  t.after(() => fixture.close());

  const invalid = await fetch(`${fixture.baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      database: 'analytics', table: 'orders', templateId: 'total-rows', capture: true, runId: '../escape'
    })
  });
  assert.equal(invalid.status, 400);
  assert.equal(captureCalls.length, 0);

  const valid = await fetch(`${fixture.baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      database: 'analytics', table: 'orders', templateId: 'total-rows', capture: true, runId: 'run-safe_123'
    })
  });
  const payload = await valid.json();
  assert.equal(valid.status, 200);
  assert.equal(captureCalls[0].runId, 'run-safe_123');
  assert.equal(payload.artifact.runId, 'run-safe_123');
  assert.equal(payload.artifact.folderPath, 'captures/run-safe_123');
  assert.equal(payload.artifact.imageFolderPath, 'captures/run-safe_123/orders');
  assert.equal(payload.artifact.truncated, true);
  assert.equal(payload.artifact.queryTruncated, false);
  assert.equal(payload.artifact.captureTruncated, true);
  assert.equal(payload.artifact.returnedRowCount, 150);
  assert.equal(payload.artifact.capturedRowCount, 150);
  assert.equal(payload.artifact.totalRowCount, 501);
  assert.equal(Object.hasOwn(payload.artifact, 'imageUrl'), false);
});

test('open-folder response never exposes an absolute filesystem path', async (t) => {
  const fixture = await startTestApplication();
  t.after(() => fixture.close());
  const response = await fetch(`${fixture.baseUrl}/api/open-folder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'public' })
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.path, 'public');
  assert.equal(path.isAbsolute(payload.path), false);
});

test('malformed or remote Host stays inside the request boundary and server remains alive', async (t) => {
  const fixture = await startTestApplication();
  t.after(() => fixture.close());
  const port = fixture.server.address().port;

  const rawResponse = await rawHttp(
    port,
    'GET /api/status HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n'
  );
  assert.match(rawResponse, /^HTTP\/1\.1 400/m);

  const remoteHostResponse = await rawHttp(
    port,
    'GET /api/status HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n'
  );
  assert.match(remoteHostResponse, /^HTTP\/1\.1 403/m);

  const secondResponse = await fetch(`${fixture.baseUrl}/api/status`);
  assert.equal(secondResponse.status, 200);
});

test('warmup key count has a hard limit before browser work starts', async (t) => {
  const warmed = [];
  const fixture = await startTestApplication({
    captureService: makeCaptureService({
      async warmupCaptureSession(key) {
        warmed.push(key);
      }
    })
  });
  t.after(() => fixture.close());

  const response = await fetch(`${fixture.baseUrl}/api/capture/warmup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keys: Array.from({ length: 9 }, (_, index) => `worker-${index}`) })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(warmed, []);
});

test('automation route is retired instead of executing legacy task SQL', async (t) => {
  let executed = false;
  const fixture = await startTestApplication({
    mysqlService: makeMysqlService({
      async executeTemplateQuery() {
        executed = true;
        throw new Error('must not run');
      }
    })
  });
  t.after(() => fixture.close());

  const response = await fetch(`${fixture.baseUrl}/api/automation/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: [{ sql: 'SELECT SLEEP(60)' }] })
  });
  assert.equal(response.status, 410);
  assert.equal(executed, false);
});

test('ANALYZE TABLE requires an explicit confirm true before its side effect', async (t) => {
  let analyzeCalls = 0;
  const fixture = await startTestApplication({
    mysqlService: makeMysqlService({
      async analyzeTable() {
        analyzeCalls += 1;
        return [{ Msg_type: 'status', Msg_text: 'OK' }];
      }
    })
  });
  t.after(() => fixture.close());

  const denied = await fetch(`${fixture.baseUrl}/api/analyze-table`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ database: 'analytics', table: 'orders' })
  });
  assert.equal(denied.status, 400);
  assert.equal(analyzeCalls, 0);

  const allowed = await fetch(`${fixture.baseUrl}/api/analyze-table`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ database: 'analytics', table: 'orders', confirm: true })
  });
  assert.equal(allowed.status, 200);
  assert.equal(analyzeCalls, 1);
});

test('API concurrency has a hard cap', async (t) => {
  let releaseStatus;
  let enteredStatus;
  const entered = new Promise((resolve) => {
    enteredStatus = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  let calls = 0;
  const fixture = await startTestApplication({
    maxConcurrentApiRequests: 1,
    mysqlService: makeMysqlService({
      async getStatus() {
        calls += 1;
        if (calls === 1) {
          enteredStatus();
          await blocked;
        }
        return { connected: true, health: 'healthy', connection: null };
      }
    })
  });
  t.after(() => fixture.close());

  const first = fetch(`${fixture.baseUrl}/api/status`);
  await entered;
  const second = await fetch(`${fixture.baseUrl}/api/status`);
  assert.equal(second.status, 503);
  releaseStatus();
  assert.equal((await first).status, 200);
});

test('cross-origin API requests are rejected on the loopback service', async (t) => {
  const fixture = await startTestApplication();
  t.after(() => fixture.close());

  const denied = await fetch(`${fixture.baseUrl}/api/query`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://evil.example'
    },
    body: JSON.stringify({ database: 'analytics', table: 'orders', templateId: 'total-rows' })
  });
  assert.equal(denied.status, 403);
});

test('failure-log errors do not mask the original request error and 500 details stay private', async (t) => {
  const logged = [];
  const fixture = await startTestApplication({
    failureLogWriter: async () => {
      throw new Error('disk is read-only');
    },
    logger: {
      error(...args) {
        logged.push(args);
      },
      warn() {},
      info() {}
    },
    mysqlService: makeMysqlService({
      async executeTemplateQuery() {
        throw new Error('password=super-secret database diagnostic');
      }
    })
  });
  t.after(() => fixture.close());

  const response = await fetch(`${fixture.baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      database: 'analytics',
      table: 'orders',
      templateId: 'total-rows',
      fields: {}
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 500);
  assert.doesNotMatch(payload.message, /super-secret|password/i);
  assert.ok(logged.length >= 1);
});

test('designed client errors are never persisted as task-failure logs', async (t) => {
  let logAttempts = 0;
  const fixture = await startTestApplication({
    failureLogWriter: async () => {
      logAttempts += 1;
      return null;
    },
    mysqlService: makeMysqlService({
      async executeTemplateQuery() {
        const error = new Error('request conflict');
        error.statusCode = 409;
        error.expose = true;
        throw error;
      }
    })
  });
  t.after(() => fixture.close());

  const response = await fetch(`${fixture.baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ database: 'analytics', table: 'orders', templateId: 'total-rows' })
  });
  assert.equal(response.status, 409);
  assert.equal(logAttempts, 0);
});

test('structured query names are bounded before database work or failure logging', async (t) => {
  let executions = 0;
  let logAttempts = 0;
  const fixture = await startTestApplication({
    failureLogWriter: async () => {
      logAttempts += 1;
      return null;
    },
    mysqlService: makeMysqlService({
      async executeTemplateQuery() {
        executions += 1;
        return { sql: 'SELECT 1', result: { columns: [], rows: [] }, tableComment: '' };
      }
    })
  });
  t.after(() => fixture.close());

  for (const payload of [
    { database: `analytics-${'x'.repeat(70)}`, table: 'orders', templateId: 'total-rows' },
    { database: 'analytics', table: 'orders\nForged: yes', templateId: 'total-rows' },
    { database: 'analytics', table: 'orders', templateId: `total-rows-${'x'.repeat(70)}` }
  ]) {
    const response = await fetch(`${fixture.baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.equal(response.status, 400);
  }
  assert.equal(executions, 0);
  assert.equal(logAttempts, 0);
});

test('internal failure logs have hard file-count and byte budgets', async (t) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tableshot-log-budget-'));
  await fsp.mkdir(path.join(rootDir, 'public'));
  const application = serverModule.createApplication({
    rootDir,
    publicDir: path.join(rootDir, 'public'),
    capturesDir: path.join(rootDir, 'captures'),
    logsDir: path.join(rootDir, 'logs'),
    tmpDir: path.join(rootDir, 'tmp'),
    config: { host: '127.0.0.1', port: 0, queryTimeoutMs: 1_000, logRetentionMs: 0 },
    mysqlService: makeMysqlService({
      async executeTemplateQuery() {
        throw new Error(`first line\nForged: yes\u2028Paragraph: yes\u2029${'x'.repeat(10_000)}`);
      }
    }),
    captureService: makeCaptureService(),
    maxFailureLogFiles: 1,
    maxFailureLogFileBytes: 768,
    maxFailureLogTotalBytes: 768,
    logger: { error() {}, warn() {}, info() {} }
  });
  const server = http.createServer(application.requestListener);
  await listenOnFetchSafePort(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await application.shutdown();
    await fsp.rm(rootDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ database: 'analytics', table: 'orders', templateId: 'total-rows' })
    });
    assert.equal(response.status, 500);
  }
  const logFiles = (await fsp.readdir(path.join(rootDir, 'logs'))).filter((name) => name.endsWith('.log'));
  assert.equal(logFiles.length, 1);
  const logPath = path.join(rootDir, 'logs', logFiles[0]);
  const [stat, contents] = await Promise.all([fsp.stat(logPath), fsp.readFile(logPath, 'utf8')]);
  assert.ok(stat.size <= 768, `log size ${stat.size} exceeded the injected budget`);
  assert.doesNotMatch(contents, /\nForged:/);
  assert.doesNotMatch(contents, /[\u2028\u2029]/u);

  const oldDate = new Date(Date.now() - 60_000);
  await fsp.utimes(logPath, oldDate, oldDate);
  application.config.logRetentionMs = 1_000;
  const cleanup = await application.cleanupExpiredLogs();
  assert.equal(cleanup.cleared, 1);
  assert.equal((await fsp.stat(logPath)).size, 0);
  const reusedResponse = await fetch(`${baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ database: 'analytics', table: 'orders', templateId: 'total-rows' })
  });
  const reusedPayload = await reusedResponse.json();
  assert.equal(reusedResponse.status, 500);
  assert.match(reusedPayload.logPath || '', /^logs\//);
  assert.equal((await fsp.readdir(path.join(rootDir, 'logs'))).filter((name) => name.endsWith('.log')).length, 1);
  assert.ok((await fsp.stat(logPath)).size > 0);
});

test('failure-log contents stay on the validated file when the log directory is swapped', async (t) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tableshot-log-race-root-'));
  const workspace = path.dirname(rootDir);
  const logsDir = path.join(rootDir, 'logs');
  const originalLogsDir = path.join(rootDir, 'logs-original');
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'tableshot-log-race-outside-'));
  await fsp.mkdir(path.join(rootDir, 'public'));
  let swapped = false;
  const application = serverModule.createApplication({
    rootDir,
    publicDir: path.join(rootDir, 'public'),
    capturesDir: path.join(rootDir, 'captures'),
    logsDir,
    tmpDir: path.join(rootDir, 'tmp'),
    config: { host: '127.0.0.1', port: 0, queryTimeoutMs: 1_000, logRetentionMs: 0 },
    mysqlService: makeMysqlService({
      async executeTemplateQuery() {
        throw new Error('SENSITIVE-LOG-CONTENT');
      }
    }),
    captureService: makeCaptureService(),
    logger: { error() {}, warn() {}, info() {} },
    async beforeFailureLogWrite() {
      if (swapped) return;
      swapped = true;
      await fsp.rename(logsDir, originalLogsDir);
      await fsp.symlink(outside, logsDir, process.platform === 'win32' ? 'junction' : 'dir');
    }
  });
  await application.ensureDirectories();
  const server = http.createServer(application.requestListener);
  await listenOnFetchSafePort(server);
  t.after(async () => {
    server.closeAllConnections?.();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await application.shutdown();
    await fsp.unlink(logsDir).catch(() => {});
    await fsp.rm(rootDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    await fsp.rm(outside, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    void workspace;
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ database: 'analytics', table: 'orders', templateId: 'total-rows' })
  });
  assert.equal(response.status, 500);
  await response.text();
  const outsideFiles = await fsp.readdir(outside);
  const outsideContents = await Promise.all(outsideFiles.map((name) => fsp.readFile(path.join(outside, name), 'utf8')));
  assert.doesNotMatch(outsideContents.join('\n'), /SENSITIVE-LOG-CONTENT/);
});

test('log retention never deletes through a directory swapped after validation', async (t) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tableshot-log-cleanup-root-'));
  const logsDir = path.join(rootDir, 'logs');
  const originalLogsDir = path.join(rootDir, 'logs-original');
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'tableshot-log-cleanup-outside-'));
  await fsp.mkdir(path.join(rootDir, 'public'));
  await fsp.mkdir(logsDir);
  const logName = 'tableshot-20260710-000000-000-1-expired.log';
  const insideLog = path.join(logsDir, logName);
  const outsideProof = path.join(outside, logName);
  await fsp.writeFile(insideLog, 'EXPIRED-INSIDE');
  await fsp.writeFile(outsideProof, 'OUTSIDE-MUST-SURVIVE');
  const oldDate = new Date(Date.now() - 60_000);
  await fsp.utimes(insideLog, oldDate, oldDate);
  let swapped = false;
  const application = serverModule.createApplication({
    rootDir,
    publicDir: path.join(rootDir, 'public'),
    capturesDir: path.join(rootDir, 'captures'),
    logsDir,
    tmpDir: path.join(rootDir, 'tmp'),
    config: { host: '127.0.0.1', port: 0, queryTimeoutMs: 1_000, logRetentionMs: 1_000 },
    mysqlService: makeMysqlService(),
    captureService: makeCaptureService(),
    logger: { error() {}, warn() {}, info() {} },
    async beforeLogRetentionClear() {
      if (swapped) return;
      swapped = true;
      await fsp.rename(logsDir, originalLogsDir);
      await fsp.symlink(outside, logsDir, process.platform === 'win32' ? 'junction' : 'dir');
    }
  });
  await application.ensureDirectories();
  t.after(async () => {
    await application.shutdown();
    await fsp.unlink(logsDir).catch(() => {});
    await fsp.rm(rootDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    await fsp.rm(outside, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });

  await application.cleanupExpiredLogs();
  assert.equal(await fsp.readFile(outsideProof, 'utf8'), 'OUTSIDE-MUST-SURVIVE');
});

test('optional MySQL TLS CA is passed to the pool but never returned to the client', async (t) => {
  const caPath = path.join(os.tmpdir(), `tableshot-test-ca-${process.pid}-${Date.now()}.pem`);
  await fsp.writeFile(caPath, 'TEST CA', 'utf8');
  t.after(() => fsp.rm(caPath, { force: true }));
  let receivedConfig;
  const fixture = await startTestApplication({
    config: {
      host: '127.0.0.1',
      port: 0,
      mysqlSslCaPath: caPath,
      mysqlSslRejectUnauthorized: true,
      queryTimeoutMs: 15_000
    },
    mysqlService: makeMysqlService({
      async replaceConnection(config) {
        receivedConfig = config;
        return { version: '8.4.0', databases: ['analytics'] };
      }
    })
  });
  t.after(() => fixture.close());

  const response = await fetch(`${fixture.baseUrl}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'db.internal', port: 3306, user: 'tester', password: 'super-secret' })
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(receivedConfig.ssl.ca.toString('utf8'), 'TEST CA');
  assert.equal(receivedConfig.ssl.rejectUnauthorized, true);
  assert.equal(payload.connection.tls, true);
  assert.doesNotMatch(JSON.stringify(payload), /super-secret|TEST CA|tableshot-test-ca/);
});

test('startServer propagates listen errors and shutdown closes MySQL and browser resources', async (t) => {
  let mysqlClosed = 0;
  let browserClosed = 0;
  const application = serverModule.createApplication({
    config: { host: '127.0.0.1', port: 0 },
    mysqlService: makeMysqlService({
      async closeConnectionPool() {
        mysqlClosed += 1;
      }
    }),
    captureService: makeCaptureService({
      async shutdownBrowserSessions() {
        browserClosed += 1;
      }
    }),
    failureLogWriter: async () => null,
    logger: { error() {}, warn() {}, info() {} }
  });
  const server = await serverModule.startServer({
    application,
    config: { host: '127.0.0.1', port: 0 },
    installSignalHandlers: false,
    logger: { error() {}, warn() {}, info() {} }
  });
  t.after(() => server.shutdown());
  const occupiedPort = server.address().port;

  let rejectedShutdowns = 0;
  const rejectedApplication = {
    tmpDir: path.join(os.tmpdir(), 'tableshot-listen-error'),
    requestListener(_req, res) { res.end(); },
    async ensureDirectories() {},
    async shutdown() { rejectedShutdowns += 1; }
  };
  await assert.rejects(serverModule.startServer({
    application: rejectedApplication,
    config: { host: '127.0.0.1', port: occupiedPort },
    installSignalHandlers: false,
    logger: { error() {}, warn() {}, info() {} }
  }), (error) => error?.code === 'EADDRINUSE');
  assert.equal(rejectedShutdowns, 1);

  await server.shutdown();
  assert.equal(mysqlClosed, 1);
  assert.equal(browserClosed, 1);
});

test('startup never recursively deletes through a symlinked tmp root', async (t) => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'tableshot-startup-root-'));
  t.after(() => fsp.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const outside = path.join(workspace, 'outside');
  const browserProfile = path.join(outside, 'browser-profile');
  const proof = path.join(browserProfile, 'must-survive.txt');
  const linkedTmp = path.join(workspace, 'linked-tmp');
  await fsp.mkdir(browserProfile, { recursive: true });
  await fsp.writeFile(proof, 'keep');
  try {
    await fsp.symlink(outside, linkedTmp, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const application = {
    config: { host: '127.0.0.1', port: 0 },
    tmpDir: linkedTmp,
    requestListener(_req, res) { res.end(); },
    async ensureDirectories() {},
    async cleanupExpiredLogs() {},
    async shutdown() {}
  };
  const server = await serverModule.startServer({
    application,
    config: application.config,
    installSignalHandlers: false,
    logger: { error() {}, warn() {}, info() {} }
  });
  t.after(() => server.shutdown());
  assert.equal(await fsp.readFile(proof, 'utf8'), 'keep');
});

test('application startup rejects a public directory symlink outside the project root', async (t) => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'tableshot-public-root-'));
  const rootDir = path.join(workspace, 'root');
  const outside = path.join(workspace, 'outside-public');
  const publicDir = path.join(rootDir, 'public');
  await fsp.mkdir(rootDir, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'must-not-be-served');
  try {
    await fsp.symlink(outside, publicDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const application = serverModule.createApplication({
    rootDir,
    publicDir,
    capturesDir: path.join(rootDir, 'captures'),
    logsDir: path.join(rootDir, 'logs'),
    tmpDir: path.join(rootDir, 'tmp'),
    config: { host: '127.0.0.1', port: 0, queryTimeoutMs: 1_000, logRetentionMs: 0 },
    mysqlService: makeMysqlService(),
    captureService: makeCaptureService(),
    failureLogWriter: async () => null,
    logger: { error() {}, warn() {}, info() {} }
  });
  await assert.rejects(application.ensureDirectories(), /静态资源目录|符号链接|边界/);

  const server = http.createServer(application.requestListener);
  await listenOnFetchSafePort(server);
  t.after(async () => {
    server.closeAllConnections?.();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await application.shutdown();
    await fsp.unlink(publicDir).catch(() => {});
    await fsp.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/secret.txt`, {
    headers: { connection: 'close' }
  });
  assert.ok([403, 500].includes(response.status));
  assert.doesNotMatch(await response.text(), /must-not-be-served/);
});

test('static responses remain bound to the validated file when the directory is swapped', async (t) => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'tableshot-static-race-'));
  const rootDir = path.join(workspace, 'root');
  const publicDir = path.join(rootDir, 'public');
  const originalPublicDir = path.join(rootDir, 'public-original');
  const outside = path.join(workspace, 'outside-public');
  await fsp.cp(path.resolve(__dirname, '..', 'public'), publicDir, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(publicDir, 'app.js'), 'SAFE-INSIDE');
  await fsp.writeFile(path.join(outside, 'app.js'), 'SECRET-OUTSIDE');
  let swapped = false;
  const application = serverModule.createApplication({
    rootDir,
    publicDir,
    capturesDir: path.join(rootDir, 'captures'),
    logsDir: path.join(rootDir, 'logs'),
    tmpDir: path.join(rootDir, 'tmp'),
    config: { host: '127.0.0.1', port: 0, queryTimeoutMs: 1_000, logRetentionMs: 0 },
    mysqlService: makeMysqlService(),
    captureService: makeCaptureService(),
    failureLogWriter: async () => null,
    logger: { error() {}, warn() {}, info() {} },
    async beforeStaticRead() {
      if (swapped) return;
      swapped = true;
      await fsp.rename(publicDir, originalPublicDir);
      await fsp.symlink(outside, publicDir, process.platform === 'win32' ? 'junction' : 'dir');
    }
  });
  await application.ensureDirectories();
  const capturePath = path.join(rootDir, 'captures', 'proof.png');
  await fsp.writeFile(capturePath, 'PNG-MUST-STAY-LOCAL');
  const server = http.createServer(application.requestListener);
  await listenOnFetchSafePort(server);
  t.after(async () => {
    server.closeAllConnections?.();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await application.shutdown();
    await fsp.unlink(publicDir).catch(() => {});
    await fsp.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });

  const captureResponse = await fetch(`http://127.0.0.1:${server.address().port}/captures/proof.png`, {
    headers: { connection: 'close' }
  });
  assert.equal(captureResponse.status, 404);
  assert.doesNotMatch(await captureResponse.text(), /PNG-MUST-STAY-LOCAL/);

  const adsResponse = await fetch(`http://127.0.0.1:${server.address().port}/app.js:hidden`, {
    headers: { connection: 'close' }
  });
  assert.equal(adsResponse.status, 400);
  await adsResponse.text();

  const response = await fetch(`http://127.0.0.1:${server.address().port}/app.js`, {
    headers: { connection: 'close' }
  });
  const body = await response.text();
  assert.notEqual(body, 'SECRET-OUTSIDE');
  if (response.status === 200) {
    assert.equal(body, 'SAFE-INSIDE');
  } else {
    assert.ok([403, 500].includes(response.status), `unexpected fail-closed status ${response.status}`);
  }
});
