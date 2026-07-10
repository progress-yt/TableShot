const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createApplication, startServer } = require('../server');

test('real application serves the login, preview assets, and disconnected status safely', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tableshot-smoke-'));
  const publicDir = path.join(rootDir, 'public');
  await fs.cp(path.resolve(__dirname, '..', 'public'), publicDir, { recursive: true });
  const application = createApplication({
    rootDir,
    publicDir,
    capturesDir: path.join(rootDir, 'captures'),
    logsDir: path.join(rootDir, 'logs'),
    tmpDir: path.join(rootDir, 'tmp'),
    config: {
      host: '127.0.0.1',
      port: 0,
      mysqlSslCaPath: '',
      mysqlSslRejectUnauthorized: true,
      queryTimeoutMs: 1_000,
      logRetentionMs: 0
    },
    logger: { info() {}, error() {} }
  });
  const server = await startServer({
    application,
    config: { ...application.config, port: 0 },
    installSignalHandlers: false,
    logger: { info() {}, error() {} }
  });
  t.after(async () => {
    await server.shutdown();
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const [loginResponse, previewResponse, coreResponse, statusResponse] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/app?preview=1`),
    fetch(`${baseUrl}/app-core.js`),
    fetch(`${baseUrl}/api/status`)
  ]);

  assert.equal(loginResponse.status, 200);
  assert.equal(previewResponse.status, 200);
  assert.equal(coreResponse.status, 200);
  assert.equal(statusResponse.status, 200);
  assert.match(loginResponse.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(loginResponse.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(await previewResponse.text(), /app-core\.js/);
  assert.match(await coreResponse.text(), /createRequestCoordinator/);
  const status = await statusResponse.json();
  assert.equal(status.connected, false);
  assert.equal(status.health, 'disconnected');
  assert.equal(status.connection, null);
  assert.equal(status.lastCheckedAt, null);
  assert.ok(['available', 'missing'].includes(status.browser));
});
