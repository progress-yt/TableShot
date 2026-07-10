'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BoundedDeadlineQueue,
  CAPTURE_HARD_LIMITS,
  assertActiveRegistryEntry,
  atomicWriteFile,
  cleanupExpiredEntries,
  countTrackedCaptureSessions,
  createCaptureService,
  deleteRegistryEntryIfCurrent,
  enforceSessionCapacity,
  isRetryableCaptureError,
  normalizeCaptureClip,
  normalizeCaptureLimits,
  resolvePathWithin,
  sanitizePathComponent,
  validateCaptureProfileKey,
  withTimeout
} = require('../lib/capture');

async function makeTempWorkspace(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tableshot-capture-test-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const capturesDir = path.join(rootDir, 'captures');
  const tmpDir = path.join(rootDir, 'tmp');
  await Promise.all([
    fs.mkdir(capturesDir, { recursive: true }),
    fs.mkdir(tmpDir, { recursive: true })
  ]);
  return { rootDir, capturesDir, tmpDir };
}

function createTestService(workspace, overrides = {}) {
  return createCaptureService({
    ...workspace,
    maxCaptureRows: 150,
    maxCaptureWidth: 2200,
    maxCaptureHeight: 9000,
    minCaptureWidth: 420,
    minCaptureHeight: 220,
    sanitizeFileName: (value) => String(value ?? '').trim(),
    resolveCaptureFileName: (_templateId, imageName) => imageName,
    ensureDirectories: async () => {
      await Promise.all([
        fs.mkdir(workspace.capturesDir, { recursive: true }),
        fs.mkdir(workspace.tmpDir, { recursive: true })
      ]);
    },
    cleanupOnStart: false,
    ...overrides
  });
}

function artifactInput(overrides = {}) {
  return {
    taskName: 'daily-report',
    templateId: 'preview',
    imageName: 'result',
    table: 'orders',
    tableComment: '',
    sql: 'SELECT 1',
    result: { columns: ['value'], rows: [{ value: 1 }] },
    captureProfileKey: '',
    captureOptions: {},
    ...overrides
  };
}

test('path components reject dot segments and Windows reserved names', () => {
  for (const invalid of ['.', '..', 'CON', 'con.txt', 'NUL', 'COM1', 'lpt9.csv']) {
    assert.throws(
      () => sanitizePathComponent(invalid),
      (error) => error?.statusCode === 400 && /名称/.test(error.message),
      invalid
    );
  }

  assert.equal(sanitizePathComponent('../sales\\2026'), '-sales-2026');
  assert.equal(sanitizePathComponent(' report. '), 'report');
});

test('resolved artifact paths cannot escape their declared root', () => {
  const root = path.resolve('captures-root');
  assert.equal(resolvePathWithin(root, 'task', 'run', 'image.png'), path.join(root, 'task', 'run', 'image.png'));
  assert.throws(() => resolvePathWithin(root, '..', 'outside.png'), /目录边界/);
  assert.throws(() => resolvePathWithin(root, path.resolve(root, '..', 'outside.png')), /目录边界/);
});

test('reusable capture profile keys use a bounded canonical format', () => {
  assert.equal(validateCaptureProfileKey('batch-worker-12'), 'batch-worker-12');
  assert.equal(validateCaptureProfileKey('single_run'), 'single_run');
  assert.equal(validateCaptureProfileKey(''), '');

  for (const invalid of ['.', '..', '../worker', 'worker/name', 'has space', 'CON', 'x'.repeat(65)]) {
    assert.throws(() => validateCaptureProfileKey(invalid), (error) => error?.statusCode === 400, invalid);
  }
});

test('capture bounds have absolute dimension, row, scale and pixel ceilings', () => {
  const limits = normalizeCaptureLimits({
    maxCaptureRows: Number.MAX_SAFE_INTEGER,
    maxCaptureWidth: Number.MAX_SAFE_INTEGER,
    maxCaptureHeight: Number.MAX_SAFE_INTEGER,
    minCaptureWidth: 1,
    minCaptureHeight: 1,
    captureDeviceScaleFactor: 100,
    maxCapturePixelBudget: Number.MAX_SAFE_INTEGER
  });

  assert.ok(limits.maxCaptureRows <= CAPTURE_HARD_LIMITS.maxRows);
  assert.ok(limits.maxCaptureWidth <= CAPTURE_HARD_LIMITS.maxWidth);
  assert.ok(limits.maxCaptureHeight <= CAPTURE_HARD_LIMITS.maxHeight);
  assert.ok(limits.captureDeviceScaleFactor <= CAPTURE_HARD_LIMITS.maxDeviceScaleFactor);
  assert.ok(limits.maxCapturePixelBudget <= CAPTURE_HARD_LIMITS.maxPixelBudget);

  const clip = normalizeCaptureClip(
    { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER },
    { width: limits.maxCaptureWidth, height: limits.maxCaptureHeight },
    limits
  );
  const outputPixels = clip.width * clip.height * limits.captureDeviceScaleFactor ** 2;
  assert.ok(outputPixels <= limits.maxCapturePixelBudget, `${outputPixels} > ${limits.maxCapturePixelBudget}`);
});

test('session capacity refuses a new browser while allowing an existing key', () => {
  assert.doesNotThrow(() => enforceSessionCapacity(2, 2, true));
  assert.throws(
    () => enforceSessionCapacity(2, 2, false),
    (error) => error?.statusCode === 429 && /会话/.test(error.message)
  );
  assert.equal(countTrackedCaptureSessions(new Map([['active', {}]]), new Set([{}])), 2);
  assert.throws(
    () => enforceSessionCapacity(
      countTrackedCaptureSessions(new Map([['active', {}]]), new Set([{}])),
      2,
      false
    ),
    (error) => error?.statusCode === 429
  );
});

test('a stale capture session cannot delete or revive over its registry replacement', () => {
  const registry = new Map();
  const stale = { stopped: false };
  const replacement = { stopped: false };
  registry.set('worker-1', replacement);

  assert.equal(deleteRegistryEntryIfCurrent(registry, 'worker-1', stale), false);
  assert.equal(registry.get('worker-1'), replacement);
  assert.throws(
    () => assertActiveRegistryEntry(registry, 'worker-1', stale),
    (error) => error?.code === 'CAPTURE_SESSION_STALE'
  );
  assert.doesNotThrow(() => assertActiveRegistryEntry(registry, 'worker-1', replacement));

  replacement.stopped = true;
  assert.throws(
    () => assertActiveRegistryEntry(registry, 'worker-1', replacement),
    (error) => error?.code === 'CAPTURE_SESSION_STALE'
  );
  assert.equal(isRetryableCaptureError({ code: 'CAPTURE_SESSION_STALE' }), true);
  assert.equal(isRetryableCaptureError(new Error('浏览器退出，状态码 21。')), true);
  assert.equal(isRetryableCaptureError(new Error('permanent failure')), false);
});

test('capture queue is bounded and expired queued work never starts or writes', async (t) => {
  const workspace = await makeTempWorkspace(t);
  const unexpectedPath = path.join(workspace.capturesDir, 'expired-queue-work.png');
  const queue = new BoundedDeadlineQueue({ maxPending: 2 });
  let releaseActive;
  const active = queue.enqueue(() => new Promise((resolve) => {
    releaseActive = resolve;
  }));
  const expired = queue.enqueue(async () => {
    await fs.writeFile(unexpectedPath, 'must-not-run');
  }, { deadline: Date.now() + 30 });

  await assert.rejects(
    queue.enqueue(async () => {}, { deadline: Date.now() + 1_000 }),
    (error) => error?.statusCode === 429 && error?.code === 'CAPTURE_QUEUE_FULL'
  );
  await assert.rejects(expired, (error) => error?.code === 'CAPTURE_DEADLINE_EXCEEDED');
  releaseActive();
  await active;
  await assert.rejects(fs.stat(unexpectedPath), { code: 'ENOENT' });
  assert.equal(queue.pendingCount, 0);
});

test('aborted queued capture is removed without starting later work', async () => {
  const queue = new BoundedDeadlineQueue({ maxPending: 2 });
  let releaseActive;
  const active = queue.enqueue(() => new Promise((resolve) => {
    releaseActive = resolve;
  }));
  const controller = new AbortController();
  let queuedCalls = 0;
  const queued = queue.enqueue(async () => {
    queuedCalls += 1;
  }, { signal: controller.signal, deadline: Date.now() + 1_000 });

  controller.abort();
  await assert.rejects(queued, (error) => error?.code === 'CAPTURE_CANCELLED');
  releaseActive();
  await active;
  assert.equal(queuedCalls, 0);
  assert.equal(queue.pendingCount, 0);
});

test('cancelling a capture queue aborts active work and all waiters', async () => {
  const queue = new BoundedDeadlineQueue({ maxPending: 2 });
  let activeSignal;
  const active = queue.enqueue(({ signal }) => new Promise((_resolve, reject) => {
    activeSignal = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  let queuedCalls = 0;
  const queued = queue.enqueue(async () => {
    queuedCalls += 1;
  });
  const cancellation = Object.assign(new Error('session stopped'), { code: 'CAPTURE_SESSION_STALE' });

  queue.cancelAll(cancellation);
  await assert.rejects(active, (error) => error === cancellation);
  await assert.rejects(queued, (error) => error === cancellation);
  assert.equal(activeSignal.aborted, true);
  assert.equal(queuedCalls, 0);

  assert.equal(queue.pendingCount, 0);
});

test('timeout wrapper rejects work that never settles', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 20, 'operation timed out'),
    /operation timed out/
  );
});

test('atomic PNG writes leave only the complete destination', async (t) => {
  const workspace = await makeTempWorkspace(t);
  const imagePath = path.join(workspace.capturesDir, 'result.png');
  await atomicWriteFile(imagePath, Buffer.from('complete-png'));

  assert.equal(await fs.readFile(imagePath, 'utf8'), 'complete-png');
  assert.deepEqual(await fs.readdir(workspace.capturesDir), ['result.png']);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(imagePath)).mode & 0o777, 0o600);
  }
  await assert.rejects(atomicWriteFile(imagePath, Buffer.from('replacement')), { code: 'EEXIST' });
  assert.equal(await fs.readFile(imagePath, 'utf8'), 'complete-png');

  const racingPath = path.join(workspace.capturesDir, 'racing.png');
  const raced = await Promise.allSettled([
    atomicWriteFile(racingPath, Buffer.from('first')),
    atomicWriteFile(racingPath, Buffer.from('second'))
  ]);
  assert.equal(raced.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(raced.filter((entry) => entry.status === 'rejected' && entry.reason?.code === 'EEXIST').length, 1);
  assert.ok(['first', 'second'].includes(await fs.readFile(racingPath, 'utf8')));
  assert.deepEqual((await fs.readdir(workspace.capturesDir)).sort(), ['racing.png', 'result.png']);
});

test('atomic PNG publication fails closed when hard links are unavailable', async (t) => {
  const workspace = await makeTempWorkspace(t);
  const imagePath = path.join(workspace.capturesDir, 'unsupported.png');
  const unsupportedLink = async () => {
    throw Object.assign(new Error('hard links unavailable'), { code: 'EPERM' });
  };

  await assert.rejects(
    atomicWriteFile(imagePath, Buffer.from('never-publish'), { linkFile: unsupportedLink }),
    (error) => error?.code === 'EPERM'
  );
  await assert.rejects(fs.stat(imagePath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(workspace.capturesDir), []);
});

test('retention cleanup removes expired files but preserves fresh and protected files', async (t) => {
  const workspace = await makeTempWorkspace(t);
  const oldPath = path.join(workspace.tmpDir, 'old.html');
  const freshPath = path.join(workspace.tmpDir, 'fresh.html');
  const protectedDir = path.join(workspace.tmpDir, 'browser-profile', 'active');
  const protectedPath = path.join(protectedDir, 'old.lock');
  await fs.mkdir(protectedDir, { recursive: true });
  await Promise.all([
    fs.writeFile(oldPath, 'old'),
    fs.writeFile(freshPath, 'fresh'),
    fs.writeFile(protectedPath, 'active')
  ]);
  const now = Date.now();
  const oldDate = new Date(now - 10_000);
  await Promise.all([
    fs.utimes(oldPath, oldDate, oldDate),
    fs.utimes(protectedPath, oldDate, oldDate)
  ]);

  const summary = await cleanupExpiredEntries(workspace.tmpDir, {
    retentionMs: 5_000,
    now,
    protectedPaths: [protectedDir]
  });

  await assert.rejects(fs.stat(oldPath), { code: 'ENOENT' });
  assert.equal(await fs.readFile(freshPath, 'utf8'), 'fresh');
  assert.equal(await fs.readFile(protectedPath, 'utf8'), 'active');
  assert.equal(summary.filesRemoved, 1);
});

test('retention cleanup rejects a symlink root without touching its target', async (t) => {
  const workspace = await makeTempWorkspace(t);
  const target = path.join(workspace.rootDir, 'outside-target');
  const linkedRoot = path.join(workspace.rootDir, 'linked-root');
  const proof = path.join(target, 'must-survive.txt');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(proof, 'keep');
  const oldDate = new Date(Date.now() - 60_000);
  await fs.utimes(proof, oldDate, oldDate);
  try {
    await fs.symlink(target, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    cleanupExpiredEntries(linkedRoot, { retentionMs: 1, now: Date.now() }),
    /symbolic|symlink|符号链接|目录根/i
  );
  assert.equal(await fs.readFile(proof, 'utf8'), 'keep');
});

test('retention cleanup does not follow a directory swapped to a junction after enumeration', async (t) => {
  const workspace = await makeTempWorkspace(t);
  const cleanupRoot = path.join(workspace.tmpDir, 'cleanup-root');
  const child = path.join(cleanupRoot, 'child');
  const originalChild = path.join(cleanupRoot, 'child-original');
  const outside = path.join(workspace.rootDir, 'outside-retention-target');
  const proof = path.join(outside, 'must-survive.txt');
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(proof, 'keep');
  const oldDate = new Date(Date.now() - 60_000);
  await fs.utimes(proof, oldDate, oldDate);
  let swapped = false;

  await cleanupExpiredEntries(cleanupRoot, {
    retentionMs: 1_000,
    async beforeEntryStat({ candidate }) {
      if (swapped || candidate !== child) return;
      swapped = true;
      await fs.rename(child, originalChild);
      await fs.symlink(outside, child, process.platform === 'win32' ? 'junction' : 'dir');
    }
  });

  assert.equal(await fs.readFile(proof, 'utf8'), 'keep');
  await fs.unlink(child).catch(() => {});
});

test('createArtifact rejects unsafe names before attempting a browser capture', async (t) => {
  const workspace = await makeTempWorkspace(t);
  let captureCalls = 0;
  const service = createTestService(workspace, {
    captureScreenshotImpl: async () => {
      captureCalls += 1;
    }
  });

  for (const invalid of ['.', '..', 'CON', 'nul.txt']) {
    await assert.rejects(
      service.createArtifact(artifactInput({ taskName: invalid })),
      (error) => error?.statusCode === 400,
      invalid
    );
  }
  await assert.rejects(
    service.createArtifact(artifactInput({ runId: '..' })),
    (error) => error?.statusCode === 400
  );
  assert.equal(captureCalls, 0);
  await service.shutdownBrowserSessions();
});

test('artifact deadline aborts capture work before any final image is published', async (t) => {
  const workspace = await makeTempWorkspace(t);
  let captureControl;
  const service = createTestService(workspace, {
    captureTaskTimeoutMs: 30,
    captureScreenshotImpl: async (_html, _imagePath, _columns, _rows, _profileKey, control) => {
      captureControl = control;
      await new Promise((_resolve, reject) => {
        control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true });
      });
    }
  });
  const imagePath = path.join(
    workspace.capturesDir,
    'deadline-run',
    'daily-report',
    'orders',
    'result.png'
  );

  await assert.rejects(
    service.createArtifact(artifactInput({ runId: 'deadline-run' })),
    /截图任务执行超时/
  );
  assert.ok(captureControl);
  assert.equal(captureControl.signal.aborted, true);
  await assert.rejects(fs.stat(imagePath), { code: 'ENOENT' });
  await service.shutdownBrowserSessions();
});

test('each artifact gets a unique run folder and canonical server paths', async (t) => {
  const workspace = await makeTempWorkspace(t);
  const service = createTestService(workspace, {
    captureScreenshotImpl: async (_html, imagePath) => {
      await atomicWriteFile(imagePath, Buffer.from('png'));
    }
  });

  const first = await service.createArtifact(artifactInput());
  const second = await service.createArtifact(artifactInput());

  assert.notEqual(first.folderPath, second.folderPath);
  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.imagePath, second.imagePath);
  assert.equal(path.dirname(first.imagePath), path.join(workspace.rootDir, first.imageFolderPath));
  assert.equal(path.dirname(second.imagePath), path.join(workspace.rootDir, second.imageFolderPath));
  assert.equal(path.join(workspace.rootDir, first.folderPath), path.join(workspace.capturesDir, first.runId));
  assert.equal(Object.hasOwn(first, 'imageUrl'), false);
  assert.equal(await fs.readFile(first.imagePath, 'utf8'), 'png');
  assert.equal(await fs.readFile(second.imagePath, 'utf8'), 'png');

  const batchOne = await service.createArtifact(artifactInput({ runId: 'batch-20260710', imageName: 'one' }));
  const batchTwo = await service.createArtifact(artifactInput({
    runId: 'batch-20260710',
    taskName: 'other-task',
    table: 'customers',
    imageName: 'two'
  }));
  assert.equal(batchOne.runId, 'batch-20260710');
  assert.equal(batchOne.folderPath, batchTwo.folderPath);
  assert.notEqual(batchOne.imageFolderPath, batchTwo.imageFolderPath);
  assert.equal(path.basename(batchOne.imagePath), 'one.png');
  assert.equal(path.basename(batchTwo.imagePath), 'two.png');
  await assert.rejects(
    service.createArtifact(artifactInput({ runId: 'batch-20260710', imageName: 'one' })),
    (error) => error?.statusCode === 409
  );
  await service.shutdownBrowserSessions();
});

test('captures are retained by default unless artifact retention is explicitly configured', async (t) => {
  const workspace = await makeTempWorkspace(t);
  const legacyPath = path.join(workspace.capturesDir, 'legacy.png');
  await fs.writeFile(legacyPath, 'keep');
  const oldDate = new Date(Date.now() - 60_000);
  await fs.utimes(legacyPath, oldDate, oldDate);
  const service = createTestService(workspace, {
    cleanupOnStart: true,
    captureScreenshotImpl: async (_html, imagePath) => atomicWriteFile(imagePath, Buffer.from('png'))
  });

  await service.createArtifact(artifactInput());
  assert.equal(await fs.readFile(legacyPath, 'utf8'), 'keep');
  await service.shutdownBrowserSessions();
});

test('explicit retention policy is applied during service startup and awaited by artifact creation', async (t) => {
  const workspace = await makeTempWorkspace(t);
  const legacyCapture = path.join(workspace.capturesDir, 'expired.png');
  const legacyTemporary = path.join(workspace.tmpDir, 'expired.html');
  await Promise.all([
    fs.writeFile(legacyCapture, 'expired'),
    fs.writeFile(legacyTemporary, 'expired')
  ]);
  const oldDate = new Date(Date.now() - 60_000);
  await Promise.all([
    fs.utimes(legacyCapture, oldDate, oldDate),
    fs.utimes(legacyTemporary, oldDate, oldDate)
  ]);
  const service = createTestService(workspace, {
    cleanupOnStart: true,
    artifactRetentionMs: 1_000,
    tmpRetentionMs: 1_000,
    captureScreenshotImpl: async (_html, imagePath) => atomicWriteFile(imagePath, Buffer.from('png'))
  });

  await service.createArtifact(artifactInput());
  await Promise.all([
    assert.rejects(fs.stat(legacyCapture), { code: 'ENOENT' }),
    assert.rejects(fs.stat(legacyTemporary), { code: 'ENOENT' })
  ]);
  await service.shutdownBrowserSessions();
});

test('capture failures keep diagnostics internally without leaking filesystem paths', async (t) => {
  const workspace = await makeTempWorkspace(t);
  const service = createTestService(workspace, {
    captureScreenshotImpl: async () => {
      throw new Error('browser failed');
    }
  });

  await assert.rejects(service.createArtifact(artifactInput()), (error) => {
    assert.doesNotMatch(error.message, new RegExp(workspace.rootDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(error.internalHtmlPath);
    assert.equal(resolvePathWithin(workspace.tmpDir, path.relative(workspace.tmpDir, error.internalHtmlPath)), error.internalHtmlPath);
    return true;
  });
  await service.shutdownBrowserSessions();
});

test('capture failure diagnostics have hard file-count and byte budgets', async (t) => {
  const workspace = await makeTempWorkspace(t);
  const service = createTestService(workspace, {
    maxDiagnosticFiles: 1,
    maxDiagnosticFileBytes: 64 * 1024,
    maxDiagnosticTotalBytes: 64 * 1024,
    captureScreenshotImpl: async () => {
      throw new Error('browser failed');
    }
  });

  let firstPath = '';
  await assert.rejects(service.createArtifact(artifactInput()), (error) => {
    firstPath = error.internalHtmlPath || '';
    return Boolean(firstPath);
  });
  await assert.rejects(service.createArtifact(artifactInput()), (error) => !error.internalHtmlPath);
  const failureDir = path.join(workspace.tmpDir, 'capture-failures');
  const entries = (await fs.readdir(failureDir)).filter((name) => name.endsWith('.html'));
  assert.equal(entries.length, 1);
  assert.ok((await fs.stat(firstPath)).size <= 64 * 1024);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(firstPath)).mode & 0o777, 0o600);
  }
  await service.shutdownBrowserSessions();
});

test('diagnostic HTML persistence cannot mask the original capture failure', async (t) => {
  const workspace = await makeTempWorkspace(t);
  await fs.writeFile(path.join(workspace.tmpDir, 'capture-failures'), 'not-a-directory');
  const service = createTestService(workspace, {
    captureScreenshotImpl: async () => {
      throw new Error('browser failure sentinel');
    }
  });

  await assert.rejects(
    service.createArtifact(artifactInput()),
    (error) => /browser failure sentinel/.test(error.message) && !error.internalHtmlPath
  );
  await service.shutdownBrowserSessions();
});

test('row truncation is explicit in both report HTML and artifact metadata', async (t) => {
  const workspace = await makeTempWorkspace(t);
  let capturedHtml = '';
  const service = createTestService(workspace, {
    maxCaptureRows: 2,
    captureScreenshotImpl: async (html, imagePath) => {
      capturedHtml = html;
      await atomicWriteFile(imagePath, Buffer.from('png'));
    }
  });
  const artifact = await service.createArtifact(artifactInput({
    result: {
      columns: ['value'],
      rows: [{ value: 1 }, { value: 2 }, { value: 3 }],
      truncated: true,
      cellCharacterLimit: 512
    }
  }));

  assert.equal(artifact.truncated, true);
  assert.equal(artifact.queryTruncated, true);
  assert.equal(artifact.captureTruncated, true);
  assert.equal(artifact.capturedRowCount, 2);
  assert.equal(artifact.returnedRowCount, 3);
  assert.match(capturedHtml, /查询已达到服务端返回上限 3 行，实际结果可能更多；截图仅展示前 2 行/);
  assert.match(capturedHtml, /文本值最多保留前 512 个字符/);
  await service.shutdownBrowserSessions();
});

test('openFolder resolves only after spawn and always hides the Windows launcher', async (t) => {
  const workspace = await makeTempWorkspace(t);
  const calls = [];
  const service = createTestService(workspace, {
    platform: 'win32',
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      Promise.resolve().then(() => child.emit('spawn'));
      return child;
    }
  });

  await service.openFolder(workspace.capturesDir);
  assert.equal(calls[0].command, 'explorer.exe');
  assert.equal(calls[0].options.windowsHide, true);

  const failedService = createTestService(workspace, {
    platform: 'win32',
    spawnProcess() {
      const child = new EventEmitter();
      child.unref = () => {};
      Promise.resolve().then(() => child.emit('error', new Error('spawn denied')));
      return child;
    }
  });
  await assert.rejects(failedService.openFolder(workspace.capturesDir), /spawn denied/);
  await Promise.all([service.shutdownBrowserSessions(), failedService.shutdownBrowserSessions()]);
});
