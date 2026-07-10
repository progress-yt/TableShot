const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate } = require('node:timers');

const corePath = require.resolve('../public/app-core.js');

test('request coordinator aborts the previous generation and rejects stale commits', () => {
  const { createRequestCoordinator } = require(corePath);
  const requests = createRequestCoordinator();
  const first = requests.begin('table-details');
  const second = requests.begin('table-details');

  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.isCurrent(), true);
  second.finish();
  assert.equal(second.isCurrent(), false);
});

test('run lock admits only one caller until release', () => {
  const { createRunLock } = require(corePath);
  const lock = createRunLock();
  const release = lock.tryAcquire();

  assert.equal(typeof release, 'function');
  assert.equal(lock.tryAcquire(), null);
  assert.equal(lock.locked, true);
  release();
  assert.equal(lock.locked, false);
  assert.equal(typeof lock.tryAcquire(), 'function');
});

test('run ledger distinguishes completed, running, and queued cancellation exactly', () => {
  const { createRunLedger } = require(corePath);
  const ledger = createRunLedger(['a', 'b', 'c', 'd']);
  ledger.markRunning('a');
  ledger.markRunning('b');
  ledger.markSucceeded('a');
  ledger.markCancelled('b');
  assert.equal(ledger.cancelQueued(), 2);

  assert.deepEqual(ledger.counts(), {
    queued: 0,
    running: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 3,
    settled: 4,
    total: 4
  });
});

test('pagination clamps the page and renders only a bounded slice', () => {
  const { paginate } = require(corePath);
  const rows = Array.from({ length: 10_000 }, (_, index) => index);
  const page = paginate(rows, 999, 100);

  assert.equal(page.page, 100);
  assert.equal(page.pageCount, 100);
  assert.equal(page.items.length, 100);
  assert.equal(page.items[0], 9900);
});

test('query request builder emits only the server protocol fields', () => {
  const { buildQueryRequest } = require(corePath);
  const request = buildQueryRequest({
    database: 'db',
    table: 'events',
    templateId: 'time-range',
    fields: { timeField: 'created_at', ignored: 'x' },
    capture: true,
    taskName: 'run',
    runId: 'run-1',
    captureProfileKey: 'worker-1',
    captureOptions: { hideSql: true, showTableMeta: false },
    sql: 'DROP TABLE events',
    imageName: '../bad',
    tableComment: 'not part of protocol'
  });

  assert.deepEqual(request, {
    database: 'db',
    table: 'events',
    templateId: 'time-range',
    fields: { timeField: 'created_at' },
    capture: true,
    taskName: 'run',
    runId: 'run-1',
    captureProfileKey: 'worker-1'
  });
  assert.equal('sql' in request, false);
  assert.equal('imageName' in request, false);
  assert.equal('captureOptions' in request, false);
});

test('capture artifact is mandatory and must include the backend folder path', () => {
  const { requireCaptureArtifact } = require(corePath);
  assert.throws(() => requireCaptureArtifact({ ok: true }), /截图产物/);
  assert.throws(
    () => requireCaptureArtifact({ artifact: { imagePath: 'x.png' } }),
    /输出目录/
  );
  assert.throws(
    () => requireCaptureArtifact({ artifact: { imagePath: 'x.png', folderPath: 'capture/run-1' } }),
    /截断状态/
  );
  assert.deepEqual(
    requireCaptureArtifact({
      artifact: {
        imagePath: 'x.png',
        folderPath: 'capture/run-1',
        truncated: true,
        queryTruncated: true,
        captureTruncated: true,
        capturedRowCount: 150,
        returnedRowCount: 500,
        totalRowCount: 501
      }
    }),
    {
      imagePath: 'x.png',
      folderPath: 'capture/run-1',
      truncated: true,
      queryTruncated: true,
      captureTruncated: true,
      capturedRowCount: 150,
      returnedRowCount: 500,
      totalRowCount: 501
    }
  );
});

test('preview and capture descriptions disclose bounded or unknown result ranges', () => {
  const { describeCaptureCompleteness, describePreviewCompleteness, describeQueryCompleteness } = require(corePath);
  const preview = describePreviewCompleteness({
    rows: Array.from({ length: 100 }, () => ({})),
    columns: ['id'],
    truncatedRows: true,
    truncatedColumns: true,
    returnedColumnCount: 64,
    totalColumnCount: 80,
    cellCharacterLimit: 512,
    binaryValuesSummarized: true
  });
  assert.match(preview.summary, /仍有更多/);
  assert.deepEqual(preview.notices, [
    '仅展示前 100 行，表中还有更多数据',
    '仅展示前 64\/80 个字段',
    '文本单元格最多展示前 512 个字符',
    '二进制字段仅显示字节数摘要'
  ]);

  const capture = describeCaptureCompleteness({
    queryTruncated: true,
    captureTruncated: true,
    capturedRowCount: 150,
    returnedRowCount: 500,
    totalRowCount: 501
  });
  assert.match(capture.summary, /服务端返回 500 行/);
  assert.match(capture.summary, /实际结果可能更多/);
  assert.doesNotMatch(capture.summary, /501|共 501|全部 501/);

  const query = describeQueryCompleteness({
    rows: Array.from({ length: 500 }, () => ({})),
    truncated: true,
    cellCharacterLimit: 512
  });
  assert.match(query.summary, /实际结果可能更多/);
  assert.deepEqual(query.notices, [
    '仅返回前 500 行，实际结果可能更多',
    '文本值最多保留前 512 个字符'
  ]);
});

test('bounded mapper preserves input order while respecting concurrency', async () => {
  const { mapWithConcurrency } = require(corePath);
  let active = 0;
  let maximumActive = 0;
  const result = await mapWithConcurrency(['a', 'b', 'c', 'd'], 2, async (value, index) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return `${index}:${value}`;
  });

  assert.deepEqual(result, ['0:a', '1:b', '2:c', '3:d']);
  assert.equal(maximumActive, 2);
});
