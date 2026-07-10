const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const CAPTURE_HARD_LIMITS = Object.freeze({
  maxRows: 1000,
  maxWidth: 4096,
  maxHeight: 16384,
  maxDeviceScaleFactor: 2,
  maxPixelBudget: 24_000_000,
  maxBrowserSessions: 7,
  maxPendingCapturesPerSession: 4,
  maxProfileKeyLength: 64,
  maxDiagnosticFiles: 50,
  maxDiagnosticFileBytes: 2 * 1024 * 1024,
  maxDiagnosticTotalBytes: 8 * 1024 * 1024
});

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function createClientError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function createCaptureStateError(code, message, statusCode) {
  return Object.assign(createClientError(message, statusCode), { code });
}

function createCaptureCancelledError(code = 'CAPTURE_CANCELLED') {
  return createCaptureStateError(
    code,
    code === 'CAPTURE_DEADLINE_EXCEEDED' ? '截图任务等待或执行超时。' : '截图任务已取消。',
    408
  );
}

function assertCaptureNotCancelled(signal, deadline = Number.POSITIVE_INFINITY) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createCaptureCancelledError();
  }
  if (Number.isFinite(deadline) && Date.now() >= deadline) {
    throw createCaptureCancelledError('CAPTURE_DEADLINE_EXCEEDED');
  }
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function deleteRegistryEntryIfCurrent(registry, key, entry) {
  if (registry.get(key) !== entry) {
    return false;
  }
  registry.delete(key);
  return true;
}

function assertActiveRegistryEntry(registry, key, entry) {
  if (!entry || entry.stopped || registry.get(key) !== entry) {
    throw createCaptureStateError('CAPTURE_SESSION_STALE', '截图会话已失效，请重试。', 409);
  }
  return entry;
}

function countTrackedCaptureSessions(registry, stoppingSessions) {
  return registry.size + stoppingSessions.size;
}

function isRetryableCaptureError(error) {
  return error?.code === 'CAPTURE_SESSION_STALE'
    || /状态码 21/.test(String(error?.message || ''));
}

class BoundedDeadlineQueue {
  constructor(options = {}) {
    this.maxPending = clampNumber(
      Math.floor(finiteNumber(options.maxPending, 1)),
      1,
      CAPTURE_HARD_LIMITS.maxPendingCapturesPerSession
    );
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.tasks = [];
    this.activeTask = null;
    this.draining = false;
  }

  get pendingCount() {
    return this.tasks.length + (this.activeTask ? 1 : 0);
  }

  enqueue(work, options = {}) {
    if (typeof work !== 'function') {
      return Promise.reject(new TypeError('Capture queue work must be a function.'));
    }
    if (this.pendingCount >= this.maxPending) {
      return Promise.reject(createCaptureStateError(
        'CAPTURE_QUEUE_FULL',
        '截图会话等待队列已满，请稍后重试。',
        429
      ));
    }

    const deadline = Number.isFinite(Number(options.deadline)) ? Number(options.deadline) : Number.POSITIVE_INFINITY;
    if (deadline <= this.now()) {
      return Promise.reject(createCaptureCancelledError('CAPTURE_DEADLINE_EXCEEDED'));
    }
    if (options.signal?.aborted) {
      return Promise.reject(createCaptureCancelledError());
    }

    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const controller = new AbortController();
    const task = {
      abortHandler: null,
      cancelled: false,
      controller,
      deadline,
      externalSignal: options.signal || null,
      reject: rejectTask,
      resolve: resolveTask,
      settled: false,
      timer: null,
      work
    };

    const cancel = (error) => this.cancelTask(task, error);
    if (task.externalSignal) {
      task.abortHandler = () => cancel(createCaptureCancelledError());
      task.externalSignal.addEventListener('abort', task.abortHandler, { once: true });
    }
    if (Number.isFinite(deadline)) {
      task.timer = setTimeout(
        () => cancel(createCaptureCancelledError('CAPTURE_DEADLINE_EXCEEDED')),
        Math.max(1, deadline - this.now())
      );
    }

    this.tasks.push(task);
    this.drain();
    return promise;
  }

  cleanupTask(task) {
    clearTimeout(task.timer);
    if (task.externalSignal && task.abortHandler) {
      task.externalSignal.removeEventListener('abort', task.abortHandler);
    }
  }

  settleTask(task, handler, value) {
    if (task.settled) {
      return;
    }
    task.settled = true;
    this.cleanupTask(task);
    handler(value);
  }

  cancelTask(task, error = createCaptureCancelledError()) {
    if (task.settled) {
      return false;
    }
    task.cancelled = true;
    if (this.activeTask !== task) {
      const index = this.tasks.indexOf(task);
      if (index >= 0) {
        this.tasks.splice(index, 1);
      }
    }
    this.settleTask(task, task.reject, error);
    if (!task.controller.signal.aborted) {
      task.controller.abort(error);
    }
    this.drain();
    return true;
  }

  cancelPending(error = createCaptureCancelledError()) {
    for (const task of [...this.tasks]) {
      this.cancelTask(task, error);
    }
  }

  cancelAll(error = createCaptureCancelledError()) {
    if (this.activeTask) {
      this.cancelTask(this.activeTask, error);
    }
    this.cancelPending(error);
  }

  async drain() {
    if (this.draining || this.activeTask) {
      return;
    }
    this.draining = true;
    try {
      while (!this.activeTask && this.tasks.length) {
        const task = this.tasks.shift();
        if (!task || task.settled || task.cancelled) {
          continue;
        }
        if (task.deadline <= this.now()) {
          this.cancelTask(task, createCaptureCancelledError('CAPTURE_DEADLINE_EXCEEDED'));
          continue;
        }

        this.activeTask = task;
        try {
          const value = await task.work({ deadline: task.deadline, signal: task.controller.signal });
          if (task.deadline <= this.now() && !task.controller.signal.aborted) {
            this.cancelTask(task, createCaptureCancelledError('CAPTURE_DEADLINE_EXCEEDED'));
          } else if (!task.controller.signal.aborted) {
            this.settleTask(task, task.resolve, value);
          }
        } catch (error) {
          this.settleTask(task, task.reject, error);
        } finally {
          this.activeTask = null;
          this.cleanupTask(task);
        }
      }
    } finally {
      this.draining = false;
      if (!this.activeTask && this.tasks.length) {
        this.drain();
      }
    }
  }
}

function sanitizePathComponent(value, options = {}) {
  const fallback = String(options.fallback || 'query');
  const maxLength = clampNumber(Math.floor(finiteNumber(options.maxLength, 80)), 1, 120);
  let raw = String(value ?? '').trim();
  if (!raw) {
    raw = fallback;
  }
  if (raw === '.' || raw === '..') {
    throw createClientError(`名称“${raw}”不能用作文件或目录。`);
  }
  if (typeof options.sanitize === 'function') {
    raw = String(options.sanitize(raw) ?? '').trim() || fallback;
  }
  if (raw === '.' || raw === '..') {
    throw createClientError(`名称“${raw}”不能用作文件或目录。`);
  }

  let normalized = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, maxLength)
    .replace(/[ .]+$/g, '');

  if (!normalized) {
    normalized = fallback;
  }
  if (normalized === '.' || normalized === '..' || WINDOWS_RESERVED_NAME.test(normalized)) {
    throw createClientError(`名称“${raw}”不能用作文件或目录。`);
  }
  return normalized;
}

function resolvePathWithin(root, ...segments) {
  const absoluteRoot = path.resolve(String(root || ''));
  const absolute = path.resolve(absoluteRoot, ...segments.map((segment) => String(segment)));
  const relative = path.relative(absoluteRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw createClientError('目标路径超出允许的目录边界。');
  }
  return absolute;
}

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateBoundedKey(value, label, allowEmpty) {
  const key = String(value ?? '').trim();
  if (!key && allowEmpty) {
    return '';
  }
  if (
    !key
    || key.length > CAPTURE_HARD_LIMITS.maxProfileKeyLength
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)
    || WINDOWS_RESERVED_NAME.test(key)
  ) {
    throw createClientError(`${label}格式无效。`);
  }
  return key;
}

function validateCaptureProfileKey(value) {
  return validateBoundedKey(value, '截图会话标识', true);
}

function validateRunId(value) {
  return validateBoundedKey(value, '运行标识', false);
}

function createRunId() {
  const date = new Date();
  const stamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    'T',
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0'),
    String(date.getUTCMilliseconds()).padStart(3, '0'),
    'Z-',
    randomUUID().slice(0, 12)
  ].join('');
  return validateRunId(stamp);
}

function normalizeCaptureLimits(options = {}) {
  const maxCaptureRows = clampNumber(
    Math.floor(finiteNumber(options.maxCaptureRows, 150)),
    1,
    CAPTURE_HARD_LIMITS.maxRows
  );
  const maxCaptureWidth = clampNumber(
    Math.floor(finiteNumber(options.maxCaptureWidth, 2200)),
    1,
    CAPTURE_HARD_LIMITS.maxWidth
  );
  const maxCaptureHeight = clampNumber(
    Math.floor(finiteNumber(options.maxCaptureHeight, 9000)),
    1,
    CAPTURE_HARD_LIMITS.maxHeight
  );
  const captureDeviceScaleFactor = clampNumber(
    finiteNumber(options.captureDeviceScaleFactor, 1),
    0.5,
    CAPTURE_HARD_LIMITS.maxDeviceScaleFactor
  );
  const maxCapturePixelBudget = clampNumber(
    Math.floor(finiteNumber(options.maxCapturePixelBudget, CAPTURE_HARD_LIMITS.maxPixelBudget)),
    1,
    CAPTURE_HARD_LIMITS.maxPixelBudget
  );
  let minCaptureWidth = clampNumber(
    Math.floor(finiteNumber(options.minCaptureWidth, 420)),
    1,
    maxCaptureWidth
  );
  let minCaptureHeight = clampNumber(
    Math.floor(finiteNumber(options.minCaptureHeight, 220)),
    1,
    maxCaptureHeight
  );
  const maxCssPixels = Math.max(1, Math.floor(maxCapturePixelBudget / captureDeviceScaleFactor ** 2));
  if (minCaptureWidth > maxCssPixels) {
    minCaptureWidth = maxCssPixels;
  }
  if (minCaptureWidth * minCaptureHeight > maxCssPixels) {
    minCaptureHeight = Math.max(1, Math.floor(maxCssPixels / minCaptureWidth));
  }

  return {
    maxCaptureRows,
    maxCaptureWidth,
    maxCaptureHeight,
    minCaptureWidth,
    minCaptureHeight,
    captureDeviceScaleFactor,
    maxCapturePixelBudget
  };
}

function normalizeCaptureClip(measured, viewport, limits) {
  let width = clampNumber(
    Math.ceil(Number(measured?.width) || viewport.width),
    limits.minCaptureWidth,
    limits.maxCaptureWidth
  );
  let height = clampNumber(
    Math.ceil(Number(measured?.height) || viewport.height),
    limits.minCaptureHeight,
    limits.maxCaptureHeight
  );
  const maxCssPixels = Math.max(
    1,
    Math.floor(limits.maxCapturePixelBudget / limits.captureDeviceScaleFactor ** 2)
  );
  if (width > maxCssPixels) {
    width = maxCssPixels;
  }
  if (width * height > maxCssPixels) {
    height = Math.max(1, Math.floor(maxCssPixels / width));
  }

  return { x: 0, y: 0, width, height, scale: 1 };
}

function enforceSessionCapacity(currentSize, maxSessions, sessionExists) {
  if (!sessionExists && currentSize >= maxSessions) {
    throw createClientError('浏览器截图会话已达到上限，请稍后重试。', 429);
  }
}

function withTimeout(work, timeoutMs, message, onTimeout) {
  const duration = Math.max(1, Math.floor(finiteNumber(timeoutMs, 1)));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      handler(value);
    };
    const timeoutId = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {}
      finish(reject, new Error(message));
    }, duration);

    let promise;
    try {
      promise = typeof work === 'function' ? work() : work;
    } catch (error) {
      finish(reject, error);
      return;
    }
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

async function atomicWriteFile(finalPath, data, options = {}) {
  const absoluteFinalPath = path.resolve(finalPath);
  const directory = path.dirname(absoluteFinalPath);
  const linkFile = typeof options.linkFile === 'function' ? options.linkFile : fsp.link;
  const signal = options.signal;
  const temporaryPath = resolvePathWithin(
    directory,
    `.${path.basename(absoluteFinalPath)}.${process.pid}-${randomUUID()}.tmp`
  );
  if (signal?.aborted) {
    throw createCaptureCancelledError();
  }
  await fsp.mkdir(directory, { recursive: true });

  try {
    await fsp.writeFile(temporaryPath, data, { flag: 'wx', signal, mode: 0o600 });
    if (signal?.aborted) {
      throw createCaptureCancelledError();
    }
    // A same-directory hard link publishes the completed bytes atomically and
    // fails with EEXIST instead of replacing an existing artifact. There is no
    // copy fallback: exposing a partially copied final path would violate the
    // run artifact contract.
    await linkFile(temporaryPath, absoluteFinalPath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function cleanupExpiredEntries(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const retentionMs = Math.max(0, finiteNumber(options.retentionMs, 0));
  const now = finiteNumber(options.now, Date.now());
  const cutoff = now - retentionMs;
  const protectedPaths = (options.protectedPaths || [])
    .map((entry) => path.resolve(entry))
    .filter((entry) => isPathWithin(absoluteRoot, entry));
  const summary = { filesRemoved: 0, directoriesRemoved: 0 };

  if (retentionMs <= 0) {
    return summary;
  }

  let rootStat;
  try {
    rootStat = await fsp.lstat(absoluteRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return summary;
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw createClientError('清理目录根不能是符号链接或非目录节点。');
  }
  const realRoot = await fsp.realpath(absoluteRoot);

  function isProtected(candidate) {
    return protectedPaths.some((protectedPath) => isPathWithin(protectedPath, candidate));
  }

  async function walk(directory) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const candidate = resolvePathWithin(absoluteRoot, path.relative(absoluteRoot, path.join(directory, entry.name)));
      if (isProtected(candidate)) {
        continue;
      }
      await options.beforeEntryStat?.({ candidate, directory, entry });
      const stat = await fsp.lstat(candidate).catch(() => null);
      if (!stat) {
        continue;
      }
      const realCandidate = await fsp.realpath(candidate).catch(() => null);
      if (!realCandidate || !isPathWithin(realRoot, realCandidate)) {
        continue;
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await walk(candidate);
        if (stat.mtimeMs <= cutoff) {
          await fsp.rmdir(candidate).then(() => {
            summary.directoriesRemoved += 1;
          }).catch((error) => {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) {
              throw error;
            }
          });
        }
      } else if (stat.mtimeMs <= cutoff) {
        await fsp.rm(candidate, { force: true });
        summary.filesRemoved += 1;
      }
    }
  }

  await walk(absoluteRoot);
  return summary;
}

function createCaptureService(options) {
  const {
    rootDir,
    capturesDir,
    tmpDir,
    sanitizeFileName,
    resolveCaptureFileName,
    ensureDirectories,
    captureScreenshotImpl,
    spawnProcess = spawn,
    platform = process.platform
  } = options;

  resolvePathWithin(rootDir, path.relative(rootDir, capturesDir));
  resolvePathWithin(rootDir, path.relative(rootDir, tmpDir));

  const limits = normalizeCaptureLimits(options);
  const {
    maxCaptureRows,
    maxCaptureWidth,
    maxCaptureHeight,
    minCaptureWidth,
    minCaptureHeight,
    captureDeviceScaleFactor
  } = limits;

  const BROWSER_SESSION_IDLE_MS = 5 * 60 * 1000;
  const BROWSER_SESSION_START_TIMEOUT_MS = 10 * 1000;
  const PAGE_EVENT_TIMEOUT_MS = 15 * 1000;
  const CDP_COMMAND_TIMEOUT_MS = 20 * 1000;
  const SCREENSHOT_TIMEOUT_MS = 30 * 1000;
  const CAPTURE_TASK_TIMEOUT_MS = clampNumber(
    Math.floor(finiteNumber(options.captureTaskTimeoutMs, 90 * 1000)),
    25,
    90 * 1000
  );
  const BROWSER_FETCH_TIMEOUT_MS = 10 * 1000;
  const TASKKILL_TIMEOUT_MS = 8 * 1000;
  const OPEN_FOLDER_TIMEOUT_MS = 8 * 1000;
  const FILE_OPERATION_TIMEOUT_MS = 15 * 1000;
  const MAX_BROWSER_OUTPUT_CHARS = 4000;
  const CAPTURE_FONT_READY_TIMEOUT_MS = 120;
  const maxBrowserSessions = clampNumber(
    Math.floor(finiteNumber(options.maxBrowserSessions ?? process.env.MAX_BROWSER_SESSIONS, 7)),
    1,
    CAPTURE_HARD_LIMITS.maxBrowserSessions
  );
  const maxPendingCapturesPerSession = clampNumber(
    Math.floor(finiteNumber(
      options.maxPendingCapturesPerSession,
      CAPTURE_HARD_LIMITS.maxPendingCapturesPerSession
    )),
    1,
    CAPTURE_HARD_LIMITS.maxPendingCapturesPerSession
  );
  const maxDiagnosticFiles = clampNumber(
    Math.floor(finiteNumber(options.maxDiagnosticFiles, CAPTURE_HARD_LIMITS.maxDiagnosticFiles)),
    1,
    CAPTURE_HARD_LIMITS.maxDiagnosticFiles
  );
  const maxDiagnosticFileBytes = clampNumber(
    Math.floor(finiteNumber(options.maxDiagnosticFileBytes, CAPTURE_HARD_LIMITS.maxDiagnosticFileBytes)),
    1_024,
    CAPTURE_HARD_LIMITS.maxDiagnosticFileBytes
  );
  const maxDiagnosticTotalBytes = clampNumber(
    Math.floor(finiteNumber(options.maxDiagnosticTotalBytes, CAPTURE_HARD_LIMITS.maxDiagnosticTotalBytes)),
    maxDiagnosticFileBytes,
    CAPTURE_HARD_LIMITS.maxDiagnosticTotalBytes
  );
  const artifactRetentionMs = Math.max(
    0,
    finiteNumber(options.artifactRetentionMs ?? process.env.CAPTURE_RETENTION_MS, 0)
  );
  const tmpRetentionMs = Math.max(
    0,
    finiteNumber(options.tmpRetentionMs ?? process.env.CAPTURE_TMP_RETENTION_MS, 24 * 60 * 60 * 1000)
  );
  const cleanupIntervalMs = Math.max(
    1000,
    finiteNumber(options.cleanupIntervalMs ?? process.env.CAPTURE_CLEANUP_INTERVAL_MS, 60 * 60 * 1000)
  );
  const browserSessions = new Map();
  const stoppingSessions = new Set();
  const claimedImagePaths = new Set();
  let diagnosticWriteQueue = Promise.resolve();
  let cleanupPromise = null;
  let lastCleanupAt = 0;

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  async function ensureBaseDirectories() {
    await fsp.mkdir(rootDir, { recursive: true });
    if (typeof ensureDirectories === 'function') {
      await ensureDirectories();
    }
    const captureSegments = path.relative(rootDir, capturesDir).split(path.sep).filter(Boolean);
    const tmpSegments = path.relative(rootDir, tmpDir).split(path.sep).filter(Boolean);
    await Promise.all([
      ensureSafeDirectory(rootDir, captureSegments),
      ensureSafeDirectory(rootDir, tmpSegments)
    ]);
  }

  async function ensureSafeDirectory(root, segments) {
    await fsp.mkdir(root, { recursive: true });
    const realRoot = await fsp.realpath(root);
    let current = path.resolve(root);

    for (const segment of segments) {
      current = resolvePathWithin(root, path.relative(root, current), segment);
      let stat;
      try {
        stat = await fsp.lstat(current);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
        await fsp.mkdir(current);
        stat = await fsp.lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw createClientError('输出目录包含不允许的符号链接或非目录节点。');
      }
      const realCurrent = await fsp.realpath(current);
      if (!isPathWithin(realRoot, realCurrent)) {
        throw createClientError('输出目录超出允许的目录边界。');
      }
    }
    return current;
  }

  function requestRetentionCleanup(force = false) {
    if (cleanupPromise) {
      return cleanupPromise;
    }
    const cleanupStartedAt = Date.now();
    if (!force && cleanupStartedAt - lastCleanupAt < cleanupIntervalMs) {
      return Promise.resolve();
    }
    lastCleanupAt = cleanupStartedAt;
    cleanupPromise = (async () => {
      await ensureBaseDirectories();
      const protectedProfiles = Array.from(browserSessions.values()).map((session) => session.profileDir);
      const protectedArtifacts = Array.from(claimedImagePaths);
      await Promise.all([
        cleanupExpiredEntries(capturesDir, {
          retentionMs: artifactRetentionMs,
          now: cleanupStartedAt,
          protectedPaths: protectedArtifacts
        }),
        cleanupExpiredEntries(tmpDir, {
          retentionMs: tmpRetentionMs,
          now: cleanupStartedAt,
          protectedPaths: protectedProfiles
        })
      ]);
    })().finally(() => {
      cleanupPromise = null;
    });
    return cleanupPromise;
  }

  let startupCleanupPromise = Promise.resolve();
  if (options.cleanupOnStart !== false) {
    startupCleanupPromise = requestRetentionCleanup(true).catch(() => {});
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function trimBrowserOutput(output) {
    const normalized = String(output || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '';
    }
    return normalized.length > MAX_BROWSER_OUTPUT_CHARS
      ? `${normalized.slice(0, MAX_BROWSER_OUTPUT_CHARS)}...`
      : normalized;
  }

  function buildCaptureFailureMessage(browserName, baseMessage, browserOutput) {
    const details = trimBrowserOutput(browserOutput);
    return details ? `${browserName} ${baseMessage} 浏览器输出：${details}` : `${browserName} ${baseMessage}`;
  }

  function getBrowserCandidates() {
    if (platform === 'win32') {
      return [
        { name: 'Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
        { name: 'Edge', path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
        { name: 'Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
        { name: 'Chrome', path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' }
      ];
    }

    if (platform === 'darwin') {
      return [
        { name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
        { name: 'Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
        { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' }
      ];
    }

    return [
      { name: 'Chrome', path: '/usr/bin/google-chrome' },
      { name: 'Chrome', path: '/usr/bin/google-chrome-stable' },
      { name: 'Edge', path: '/usr/bin/microsoft-edge' },
      { name: 'Chromium', path: '/usr/bin/chromium' },
      { name: 'Chromium', path: '/usr/bin/chromium-browser' }
    ];
  }

  function resolveBrowserFromCommand() {
    if (platform === 'win32') {
      return null;
    }

    const commands = [
      { name: 'Chrome', command: 'google-chrome' },
      { name: 'Chrome', command: 'google-chrome-stable' },
      { name: 'Edge', command: 'microsoft-edge' },
      { name: 'Chromium', command: 'chromium' },
      { name: 'Chromium', command: 'chromium-browser' }
    ];

    for (const candidate of commands) {
      const result = spawnSync('which', [candidate.command], {
        encoding: 'utf8',
        timeout: 2000,
        windowsHide: true
      });
      const commandPath = String(result.stdout || '').trim();
      if (result.status === 0 && commandPath && fs.existsSync(commandPath)) {
        return { name: candidate.name, path: commandPath };
      }
    }

    return null;
  }

  function findBrowser() {
    const configuredPath = String(process.env.BROWSER_PATH || '').trim();
    if (configuredPath) {
      if (fs.existsSync(configuredPath)) {
        return { name: process.env.BROWSER_CHANNEL || 'ConfiguredBrowser', path: configuredPath };
      }
      return null;
    }

    for (const candidate of getBrowserCandidates()) {
      if (fs.existsSync(candidate.path)) {
        return candidate;
      }
    }

    return resolveBrowserFromCommand();
  }

  function createCaptureProfileDir(browserName) {
    const safeBrowserName = sanitizePathComponent(browserName, {
      fallback: 'browser',
      sanitize: sanitizeFileName
    }).toLowerCase();
    return resolvePathWithin(
      tmpDir,
      'browser-profile',
      `${safeBrowserName}-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`
    );
  }

  function resolveCaptureProfileDir(browserName, captureProfileKey) {
    const key = validateCaptureProfileKey(captureProfileKey);
    if (!key) {
      return { path: createCaptureProfileDir(browserName), reusable: false };
    }

    const safeBrowserName = sanitizePathComponent(browserName, {
      fallback: 'browser',
      sanitize: sanitizeFileName
    }).toLowerCase();

    return {
      path: resolvePathWithin(tmpDir, 'browser-profile', safeBrowserName, key),
      reusable: true
    };
  }

  async function waitForCaptureClip(connection, viewport) {
    const response = await connection.send('Runtime.evaluate', {
      expression: `(() => {
        const waitForFonts = document.fonts && document.fonts.ready
          ? Promise.race([
              document.fonts.ready.then(() => true).catch(() => true),
              new Promise((resolve) => setTimeout(() => resolve(true), ${CAPTURE_FONT_READY_TIMEOUT_MS}))
            ])
          : Promise.resolve(true);
        const waitForPaint = typeof requestAnimationFrame === 'function'
          ? new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))
          : new Promise((resolve) => setTimeout(() => resolve(true), 32));
        return Promise.all([waitForFonts, waitForPaint]).then(() => {
          const target = document.querySelector('.sheet') || document.body || document.documentElement;
          const doc = document.documentElement;
          const body = document.body;
          const bodyStyle = body ? getComputedStyle(body) : null;
          const padX = bodyStyle ? (parseFloat(bodyStyle.paddingLeft) || 0) + (parseFloat(bodyStyle.paddingRight) || 0) : 0;
          const padY = bodyStyle ? (parseFloat(bodyStyle.paddingTop) || 0) + (parseFloat(bodyStyle.paddingBottom) || 0) : 0;
          const rect = target ? target.getBoundingClientRect() : { width: 0, height: 0 };
          const contentWidth = target
            ? Math.max(Math.ceil(rect.width + padX), Math.ceil((target.scrollWidth || 0) + padX))
            : Math.max(doc ? doc.scrollWidth : 0, body ? body.scrollWidth : 0);
          const contentHeight = target
            ? Math.max(Math.ceil(rect.height + padY), Math.ceil((target.scrollHeight || 0) + padY))
            : Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0);
          return { width: contentWidth + 4, height: contentHeight + 4 };
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    return normalizeCaptureClip(response?.result?.value || {}, viewport, limits);
  }

  function canRetryCaptureWithDefaultEncoding(error) {
    return /optimizeForSpeed|Invalid parameters|Unknown parameter|Unexpected parameter/i.test(String(error?.message || ''));
  }

  async function capturePng(connection, clip) {
    const params = { format: 'png', fromSurface: true, captureBeyondViewport: true, clip };
    try {
      return await connection.send(
        'Page.captureScreenshot',
        { ...params, optimizeForSpeed: true },
        SCREENSHOT_TIMEOUT_MS
      );
    } catch (error) {
      if (!canRetryCaptureWithDefaultEncoding(error)) {
        throw error;
      }
    }
    return connection.send('Page.captureScreenshot', params, SCREENSHOT_TIMEOUT_MS);
  }

  class DevToolsConnection {
    constructor(endpoint) {
      this.endpoint = endpoint;
      this.nextId = 1;
      this.pending = new Map();
      this.eventWaiters = new Map();
      this.ws = null;
    }

    async open(timeoutMs = BROWSER_SESSION_START_TIMEOUT_MS) {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(this.endpoint);
        this.ws = ws;
        let timeoutId = null;
        let settled = false;

        const finalize = (handler) => (value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutId);
          handler(value);
        };

        const resolveOnce = finalize(resolve);
        const rejectOnce = finalize(reject);

        timeoutId = setTimeout(() => {
          try {
            ws.close();
          } catch {}
          rejectOnce(new Error('连接浏览器调试会话超时。'));
        }, timeoutMs);

        ws.addEventListener('open', () => resolveOnce());
        ws.addEventListener('error', () => rejectOnce(new Error('浏览器调试会话连接失败。')));
        ws.addEventListener('close', () => {
          this.rejectAllPending(new Error('浏览器调试会话已关闭。'));
        });
        ws.addEventListener('message', (event) => {
          let payload;
          try {
            payload = JSON.parse(String(event.data || ''));
          } catch {
            return;
          }
          if (payload.id && this.pending.has(payload.id)) {
            const {
              resolve: resolvePending,
              reject: rejectPending,
              timeoutId: pendingTimeoutId
            } = this.pending.get(payload.id);
            this.pending.delete(payload.id);
            clearTimeout(pendingTimeoutId);
            if (payload.error) {
              rejectPending(new Error(payload.error.message || '未知浏览器调试错误。'));
            } else {
              resolvePending(payload.result);
            }
            return;
          }
          if (!payload.method) {
            return;
          }
          const waiters = this.eventWaiters.get(payload.method) || [];
          const remaining = [];
          waiters.forEach((waiter) => {
            try {
              if (waiter.predicate(payload.params || {})) {
                clearTimeout(waiter.timeoutId);
                waiter.resolve(payload.params || {});
              } else {
                remaining.push(waiter);
              }
            } catch (error) {
              clearTimeout(waiter.timeoutId);
              waiter.reject(error);
            }
          });
          this.eventWaiters.set(payload.method, remaining);
        });
      });
    }

    send(method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
      const id = this.nextId;
      this.nextId += 1;
      const payload = JSON.stringify({ id, method, params });

      return new Promise((resolve, reject) => {
        if (!this.ws || this.ws.readyState !== 1) {
          reject(new Error('浏览器调试会话未连接。'));
          return;
        }
        const timeoutId = setTimeout(() => {
          if (!this.pending.has(id)) {
            return;
          }
          this.pending.delete(id);
          reject(new Error(`浏览器调试命令 ${method} 执行超时。`));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timeoutId });
        try {
          this.ws.send(payload);
        } catch (error) {
          clearTimeout(timeoutId);
          this.pending.delete(id);
          reject(error);
        }
      });
    }

    async waitForEvent(method, predicate = () => true, timeoutMs = PAGE_EVENT_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const waiters = this.eventWaiters.get(method) || [];
          this.eventWaiters.set(method, waiters.filter((waiter) => waiter.resolve !== resolve));
          reject(new Error(`等待浏览器事件 ${method} 超时。`));
        }, timeoutMs);

        const waiters = this.eventWaiters.get(method) || [];
        waiters.push({ predicate, resolve, reject, timeoutId });
        this.eventWaiters.set(method, waiters);
      });
    }

    rejectAllPending(error) {
      this.pending.forEach(({ reject, timeoutId }) => {
        clearTimeout(timeoutId);
        reject(error);
      });
      this.pending.clear();
      this.eventWaiters.forEach((waiters) => {
        waiters.forEach((waiter) => {
          clearTimeout(waiter.timeoutId);
          waiter.reject(error);
        });
      });
      this.eventWaiters.clear();
    }

    close() {
      if (!this.ws) {
        return;
      }
      this.rejectAllPending(new Error('浏览器调试会话已关闭。'));
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  async function fetchBrowserEndpoint(url, init = {}, parseJson = false) {
    const controller = new AbortController();
    return withTimeout(
      async () => {
        const response = await fetch(url, { ...init, signal: controller.signal });
        let body = null;
        if (parseJson && response.ok) {
          body = await response.json();
        } else {
          await response.arrayBuffer().catch(() => {});
        }
        return { response, body };
      },
      BROWSER_FETCH_TIMEOUT_MS,
      '浏览器调试接口请求超时。',
      () => controller.abort()
    );
  }

  class BrowserSession {
    constructor(sessionKey, browser, profileDir) {
      this.sessionKey = sessionKey;
      this.browser = browser;
      this.profileDir = profileDir;
      this.child = null;
      this.browserOutput = '';
      this.browserWsEndpoint = '';
      this.httpBase = '';
      this.idleTimer = null;
      this.startPromise = null;
      this.stopPromise = null;
      this.stopped = false;
      this.targetId = '';
      this.frameId = '';
      this.connection = null;
      this.captureQueue = new BoundedDeadlineQueue({ maxPending: maxPendingCapturesPerSession });
    }

    appendOutput(chunk) {
      if (!chunk) {
        return;
      }
      this.browserOutput += chunk.toString();
      if (this.browserOutput.length > MAX_BROWSER_OUTPUT_CHARS * 4) {
        this.browserOutput = this.browserOutput.slice(-MAX_BROWSER_OUTPUT_CHARS * 4);
      }
    }

    assertActive() {
      return assertActiveRegistryEntry(browserSessions, this.sessionKey, this);
    }

    async ensureStarted() {
      this.assertActive();
      if (this.startPromise) {
        return this.startPromise;
      }

      this.startPromise = (async () => {
        const relativeProfileDir = path.relative(tmpDir, this.profileDir);
        if (relativeProfileDir.startsWith('..') || path.isAbsolute(relativeProfileDir)) {
          throw createClientError('浏览器配置目录超出临时目录边界。');
        }
        await ensureSafeDirectory(tmpDir, relativeProfileDir.split(path.sep).filter(Boolean));
        this.assertActive();
        await this.sweepStaleLocks();
        this.assertActive();
        await new Promise((resolve, reject) => {
          this.assertActive();
          const args = [
            '--headless=new',
            '--disable-gpu',
            '--hide-scrollbars',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-sync',
            '--disable-extensions',
            `--user-data-dir=${this.profileDir}`,
            '--remote-debugging-port=0',
            'about:blank'
          ];

          const child = spawn(this.browser.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
          this.child = child;

          let timeoutId = null;
          let settled = false;

          const finalize = (handler) => (value) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timeoutId);
            handler(value);
          };

          const resolveOnce = finalize(resolve);
          const rejectOnce = finalize(reject);
          const inspectOutput = (chunk) => {
            this.appendOutput(chunk);
            const matched = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (!matched) {
              return;
            }
            this.browserWsEndpoint = matched[1];
            const endpointUrl = new URL(this.browserWsEndpoint);
            this.httpBase = `http://${endpointUrl.hostname}:${endpointUrl.port}`;
            resolveOnce();
          };

          timeoutId = setTimeout(() => {
            rejectOnce(new Error(buildCaptureFailureMessage(this.browser.name, '浏览器调试会话启动超时。', this.browserOutput)));
          }, BROWSER_SESSION_START_TIMEOUT_MS);

          child.stdout.on('data', inspectOutput);
          child.stderr.on('data', inspectOutput);
          child.once('error', (error) => {
            rejectOnce(new Error(buildCaptureFailureMessage(this.browser.name, `浏览器调试会话启动失败：${error.message}。`, this.browserOutput)));
          });
          child.once('exit', (code, signal) => {
            if (this.connection) {
              this.connection.close();
            }
            this.connection = null;
            this.targetId = '';
            this.frameId = '';
            this.child = null;
            this.startPromise = null;
            deleteRegistryEntryIfCurrent(browserSessions, this.sessionKey, this);
            const reason = signal
              ? `浏览器调试会话被信号 ${signal} 终止。`
              : `浏览器调试会话退出，状态码 ${code}。`;
            const exitError = new Error(buildCaptureFailureMessage(this.browser.name, reason, this.browserOutput));
            this.captureQueue.cancelPending(exitError);
            if (!settled) {
              rejectOnce(exitError);
            }
            this.stop().catch(() => {});
          });
        });

        this.assertActive();
        const page = await this.createTarget('about:blank');
        const connection = new DevToolsConnection(page.webSocketDebuggerUrl);

        try {
          await connection.open();
          await connection.send('Page.enable');
          await connection.send('Runtime.enable');
          const loadEvent = connection.waitForEvent('Page.loadEventFired');
          await connection.send('Page.navigate', { url: 'about:blank' });
          await loadEvent;
          const frameTree = await connection.send('Page.getFrameTree');
          const frameId = frameTree?.frameTree?.frame?.id;
          if (!frameId) {
            throw new Error(buildCaptureFailureMessage(this.browser.name, '浏览器页面未返回可写入的 frame。', this.browserOutput));
          }
          this.assertActive();
          this.connection = connection;
          this.targetId = page.id;
          this.frameId = frameId;
        } catch (error) {
          connection.close();
          await this.closeTarget(page.id);
          throw error;
        }
      })().catch(async (error) => {
        await this.stop().catch(() => {});
        throw error;
      });

      return this.startPromise;
    }

    scheduleStop() {
      if (this.stopped || browserSessions.get(this.sessionKey) !== this) {
        return;
      }
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.stop().catch(() => {});
      }, BROWSER_SESSION_IDLE_MS);
    }

    async createTarget(url) {
      const targetUrl = `${this.httpBase}/json/new?${encodeURIComponent(url)}`;
      let request = await fetchBrowserEndpoint(targetUrl, { method: 'PUT' }, true).catch(() => null);
      if (!request?.response?.ok) {
        request = await fetchBrowserEndpoint(targetUrl, {}, true).catch(() => null);
      }
      if (!request?.response?.ok) {
        const statusText = request?.response ? `状态码 ${request.response.status}` : '请求未建立';
        throw new Error(buildCaptureFailureMessage(this.browser.name, `浏览器页面创建失败，${statusText}。`, this.browserOutput));
      }
      return request.body;
    }

    async closeTarget(targetId) {
      if (!targetId) {
        return;
      }
      await fetchBrowserEndpoint(`${this.httpBase}/json/close/${encodeURIComponent(targetId)}`).catch(() => {});
    }

    async capture(html, imagePath, viewport, options = {}) {
      this.assertActive();
      return this.captureQueue.enqueue(
        ({ deadline, signal }) => this.performCapture(html, imagePath, viewport, { deadline, signal }),
        options
      );
    }

    async performCapture(html, imagePath, viewport, { deadline, signal }) {
      const stopOnAbort = () => {
        this.stop().catch(() => {});
      };
      signal.addEventListener('abort', stopOnAbort, { once: true });
      try {
        assertCaptureNotCancelled(signal, deadline);
        this.assertActive();
        await this.ensureStarted();
        assertCaptureNotCancelled(signal, deadline);
        this.assertActive();
        clearTimeout(this.idleTimer);

        if (!this.connection || !this.frameId) {
          throw new Error(buildCaptureFailureMessage(this.browser.name, 'capture session is not ready.', this.browserOutput));
        }

        await this.connection.send('Emulation.setDeviceMetricsOverride', {
          mobile: false,
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: captureDeviceScaleFactor
        });
        assertCaptureNotCancelled(signal, deadline);
        await this.connection.send('Page.setDocumentContent', { frameId: this.frameId, html });
        assertCaptureNotCancelled(signal, deadline);
        const clip = await waitForCaptureClip(this.connection, viewport);
        assertCaptureNotCancelled(signal, deadline);
        const screenshot = await capturePng(this.connection, clip);
        assertCaptureNotCancelled(signal, deadline);
        if (!screenshot?.data) {
          throw new Error(buildCaptureFailureMessage(this.browser.name, 'capture completed without PNG data.', this.browserOutput));
        }
        const imageBuffer = Buffer.from(screenshot.data, 'base64');
        if (!imageBuffer.length) {
          throw new Error(buildCaptureFailureMessage(this.browser.name, 'capture completed with empty PNG data.', this.browserOutput));
        }
        const fileController = new AbortController();
        const abortFile = () => fileController.abort(signal.reason);
        signal.addEventListener('abort', abortFile, { once: true });
        await withTimeout(
          () => atomicWriteFile(imagePath, imageBuffer, { signal: fileController.signal }),
          FILE_OPERATION_TIMEOUT_MS,
          '写入截图文件超时。',
          () => fileController.abort(createCaptureCancelledError('CAPTURE_DEADLINE_EXCEEDED'))
        ).finally(() => signal.removeEventListener('abort', abortFile));
        assertCaptureNotCancelled(signal, deadline);
        return imageBuffer.length;
      } catch (error) {
        await this.stop().catch(() => {});
        throw error;
      } finally {
        signal.removeEventListener('abort', stopOnAbort);
        if (!this.stopped && browserSessions.get(this.sessionKey) === this) {
          this.scheduleStop();
        }
      }
    }

    stop() {
      if (this.stopPromise) {
        return this.stopPromise;
      }
      if (this.stopped) {
        return Promise.resolve();
      }
      this.stopped = true;
      clearTimeout(this.idleTimer);
      deleteRegistryEntryIfCurrent(browserSessions, this.sessionKey, this);
      stoppingSessions.add(this);
      this.captureQueue.cancelAll(createCaptureStateError(
        'CAPTURE_SESSION_STALE',
        '截图会话已停止，请重试。',
        409
      ));
      if (this.connection) {
        try {
          this.connection.close();
        } catch {}
        this.connection = null;
      }
      const child = this.child;
      this.child = null;
      this.startPromise = null;
      this.stopPromise = (async () => {
        if (child && !child.killed && child.pid) {
          if (platform === 'win32') {
            let killer = null;
            await withTimeout(
              new Promise((resolve) => {
                killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
                  stdio: 'ignore',
                  windowsHide: true
                });
                let finished = false;
                const done = () => {
                  if (finished) {
                    return;
                  }
                  finished = true;
                  resolve();
                };
                killer.once('exit', done);
                killer.once('error', () => {
                  try {
                    child.kill();
                  } catch {}
                  done();
                });
              }),
              TASKKILL_TIMEOUT_MS,
              '终止浏览器进程超时。',
              () => {
                try {
                  killer?.kill();
                } catch {}
                try {
                  child.kill();
                } catch {}
              }
            ).catch(() => {});
          } else {
            try {
              child.kill('SIGKILL');
            } catch {}
          }
          await wait(500);
        }
        await withTimeout(
          fsp.rm(this.profileDir, { recursive: true, force: true }),
          FILE_OPERATION_TIMEOUT_MS,
          '清理浏览器配置目录超时。'
        ).catch(() => {});
      })().finally(() => {
        stoppingSessions.delete(this);
      });
      return this.stopPromise;
    }

    async sweepStaleLocks() {
      const candidates = [
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket',
        path.join('Default', 'LOCK'),
        path.join('Default', 'SingletonLock')
      ];
      await Promise.all(candidates.map((name) => fsp.rm(path.join(this.profileDir, name), { force: true }).catch(() => {})));
    }
  }

  function getBrowserSession(browser, profileDir, captureProfileKey, reusableProfile) {
    const sessionKey = `${browser.path}:${captureProfileKey}`;
    const sessionExists = browserSessions.has(sessionKey);
    enforceSessionCapacity(
      countTrackedCaptureSessions(browserSessions, stoppingSessions),
      maxBrowserSessions,
      sessionExists
    );
    if (!sessionExists) {
      const ownedProfileDir = reusableProfile
        ? resolvePathWithin(profileDir, `session-${randomUUID().slice(0, 12)}`)
        : profileDir;
      browserSessions.set(sessionKey, new BrowserSession(sessionKey, browser, ownedProfileDir));
    }
    return browserSessions.get(sessionKey);
  }

  async function warmupCaptureSession(captureProfileKey) {
    const validatedProfileKey = validateCaptureProfileKey(captureProfileKey);
    if (!validatedProfileKey) {
      throw createClientError('截图预热必须指定可复用的会话标识。');
    }
    const browser = findBrowser();
    if (!browser) {
      const error = new Error('未检测到可用于截图的浏览器，无法执行截图预热。');
      error.statusCode = 500;
      throw error;
    }
    await startupCleanupPromise;
    await requestRetentionCleanup().catch(() => {});
    const profile = resolveCaptureProfileDir(browser.name, validatedProfileKey);
    const session = getBrowserSession(browser, profile.path, validatedProfileKey, profile.reusable);
    await session.ensureStarted();
    session.scheduleStop();
  }

  function buildReportHtml({
    title,
    table,
    tableComment,
    sql,
    columns,
    rows,
    hideSql,
    showTableMeta,
    queryTruncated,
    captureTruncated,
    returnedRowCount,
    cellCharacterLimit
  }) {
    const safeColumns = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
    const safeTableName = escapeHtml(table || title || '-');
    const safeTableComment = escapeHtml(tableComment || '暂无中文注释');
    const roomyTable = columns.length <= 2;
    const tableMinWidth = roomyTable ? 640 : 0;
    const cellMaxWidth = roomyTable ? 680 : 320;
    const safeRows = rows.length
      ? rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] === null ? 'NULL' : row[column])}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${Math.max(columns.length, 1)}">No rows returned</td></tr>`;
    const truncationMessages = [];
    if (queryTruncated) {
      truncationMessages.push(`查询已达到服务端返回上限 ${returnedRowCount} 行，实际结果可能更多`);
    }
    if (captureTruncated) {
      truncationMessages.push(`截图仅展示前 ${rows.length} 行`);
    }
    if (Number.isInteger(cellCharacterLimit) && cellCharacterLimit > 0) {
      truncationMessages.push(`文本值最多保留前 ${cellCharacterLimit} 个字符`);
    }
    const truncationNotice = truncationMessages.length
      ? `<p class="truncation-notice">${truncationMessages.join('；')}。</p>`
      : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; --bg:#fff; --ink:#0f172a; --muted:#475569; --line:#cbd5e1; --accent:#1d4ed8; --sql-bg:#0f172a; --sql-ink:#e2e8f0; --head-bg:#eff6ff; }
    * { box-sizing: border-box; }
    html { background: var(--bg); width: max-content; }
    body { margin:0; padding:20px; display:inline-block; font-family:"Microsoft YaHei","Segoe UI",sans-serif; background:var(--bg); color:var(--ink); }
    .sheet { display:inline-flex; flex-direction:column; align-items:flex-start; width:max-content; max-width:${maxCaptureWidth}px; }
    .table-meta { margin:0 0 14px; padding:14px 16px; border:1px solid var(--line); border-radius:12px; background:#f8fafc; display:inline-block; max-width:${maxCaptureWidth}px; }
    .table-meta-label { margin:0 0 6px; font-size:12px; font-weight:700; letter-spacing:.04em; color:var(--accent); }
    .table-meta-name { margin:0; font-size:20px; font-weight:700; line-height:1.3; }
    .table-meta-comment { margin:6px 0 0; font-size:13px; color:var(--muted); }
    .section + .section { margin-top:14px; }
    .section { display:inline-flex; flex-direction:column; align-items:flex-start; max-width:${maxCaptureWidth}px; }
    .section-label { margin:0 0 8px; font-size:14px; font-weight:700; color:var(--accent); }
    .sql { margin:0; display:inline-block; padding:14px 16px; border:1px solid var(--line); border-radius:12px; background:var(--sql-bg); color:var(--sql-ink); font-family:"Cascadia Code","Consolas",monospace; white-space:pre-wrap; word-break:break-word; font-size:14px; line-height:1.55; max-width:${maxCaptureWidth}px; }
    .table-wrap { display:inline-block; border:1px solid var(--line); border-radius:12px; overflow:hidden; background:var(--bg); width:max-content; min-width:${tableMinWidth}px; max-width:${maxCaptureWidth}px; }
    table { width:max-content; min-width:${tableMinWidth}px; border-collapse:collapse; background:var(--bg); }
    thead th { padding:12px 14px; text-align:left; font-size:13px; font-weight:700; white-space:nowrap; background:var(--head-bg); border-bottom:1px solid var(--line); }
    tbody td { padding:11px 14px; border-bottom:1px solid var(--line); vertical-align:top; font-size:13px; max-width:${cellMaxWidth}px; white-space:pre-wrap; overflow-wrap:anywhere; }
    tbody tr:nth-child(even) td { background:#f8fafc; }
    tbody tr:last-child td { border-bottom:0; }
    .empty { padding:14px 16px; color:var(--muted); font-size:13px; }
    .truncation-notice { margin:0 0 8px; padding:8px 10px; border-radius:8px; background:#fff7ed; color:#9a3412; font-size:12px; }
  </style>
</head>
<body>
  <div class="sheet">
    ${showTableMeta ? `<section class="table-meta"><p class="table-meta-label">目标表</p><p class="table-meta-name">${safeTableName}</p><p class="table-meta-comment">${safeTableComment}</p></section>` : ''}
    ${hideSql ? '' : `<section class="section"><p class="section-label">查询语句</p><pre class="sql">${escapeHtml(sql)}</pre></section>`}
    <section class="section"><p class="section-label">查询结果</p>${truncationNotice}<div class="table-wrap">${columns.length ? `<table><thead><tr>${safeColumns}</tr></thead><tbody>${safeRows}</tbody></table>` : `<div class="empty">No rows returned</div>`}</div></section>
  </div>
</body>
</html>`;
  }

  function calculateViewport(columnsCount, rowsCount) {
    const proposed = {
      width: clampNumber(Math.max(220 * Math.max(columnsCount, 1), 720), minCaptureWidth, maxCaptureWidth),
      height: clampNumber(180 + rowsCount * 42, minCaptureHeight, maxCaptureHeight)
    };
    const bounded = normalizeCaptureClip(proposed, proposed, limits);
    return { width: bounded.width, height: bounded.height };
  }

  async function captureScreenshot(html, imagePath, columnsCount, rowsCount, captureProfileKey, options = {}) {
    const relativeImagePath = path.relative(capturesDir, imagePath);
    if (relativeImagePath.startsWith('..') || path.isAbsolute(relativeImagePath)) {
      throw createClientError('截图路径超出截图目录边界。');
    }
    const validatedProfileKey = validateCaptureProfileKey(captureProfileKey);
    const browser = findBrowser();
    if (!browser) {
      const error = new Error('未检测到可用于截图的浏览器，无法执行自动截图。');
      error.statusCode = 500;
      throw error;
    }

    const viewport = calculateViewport(columnsCount, rowsCount);
    const profile = resolveCaptureProfileDir(browser.name, validatedProfileKey);
    const profileDir = profile.path;
    const captureSessionKey = profile.reusable ? validatedProfileKey : profileDir;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const captureSession = getBrowserSession(browser, profileDir, captureSessionKey, profile.reusable);
      try {
        const imageBytes = await captureSession.capture(html, imagePath, viewport, options);
        if (!imageBytes || imageBytes <= 0) {
          throw new Error(buildCaptureFailureMessage(browser.name, '截图结束后没有生成有效的 PNG 文件。', captureSession.browserOutput));
        }
        if (!profile.reusable) {
          await captureSession.stop().catch(() => {});
        }
        return;
      } catch (error) {
        const retryable = attempt < maxAttempts && isRetryableCaptureError(error);
        if (!retryable) {
          throw error;
        }
        await wait(400);
      }
    }
  }

  function persistFailureDiagnostic(html, { runId, safeTaskName, safeTableName }) {
    const htmlBuffer = Buffer.from(html, 'utf8');
    if (htmlBuffer.length > maxDiagnosticFileBytes) {
      return Promise.resolve('');
    }
    const pending = diagnosticWriteQueue.then(async () => {
      const failureDir = await ensureSafeDirectory(tmpDir, ['capture-failures']);
      const entries = await fsp.readdir(failureDir, { withFileTypes: true });
      const diagnosticEntries = entries.filter((entry) => (
        entry.isFile()
        && /^tableshot-.*\.html$/u.test(entry.name)
      ));
      if (diagnosticEntries.length >= maxDiagnosticFiles) {
        return '';
      }
      let existingBytes = 0;
      for (const entry of diagnosticEntries) {
        const stat = await fsp.stat(path.join(failureDir, entry.name));
        existingBytes += stat.size;
        if (existingBytes + htmlBuffer.length > maxDiagnosticTotalBytes) {
          return '';
        }
      }
      const htmlPath = resolvePathWithin(
        failureDir,
        `tableshot-${nowStamp()}-${runId}-${safeTaskName}-${safeTableName}-${randomUUID().slice(0, 8)}.html`
      );
      await atomicWriteFile(htmlPath, htmlBuffer);
      return htmlPath;
    });
    diagnosticWriteQueue = pending.catch(() => '');
    return pending;
  }

  async function createArtifact({
    runId,
    taskName,
    templateId,
    imageName,
    table,
    tableComment,
    sql,
    result,
    captureProfileKey,
    captureOptions
  }) {
    await startupCleanupPromise;
    await requestRetentionCleanup().catch(() => {});
    await ensureBaseDirectories();

    const resolvedRunId = runId ? validateRunId(runId) : createRunId();
    const validatedProfileKey = validateCaptureProfileKey(captureProfileKey);
    const safeTaskName = sanitizePathComponent(taskName, {
      fallback: 'query',
      sanitize: sanitizeFileName
    });
    const safeTableName = sanitizePathComponent(table || 'single-query', {
      fallback: 'single-query',
      sanitize: sanitizeFileName
    });
    const safeImageName = sanitizePathComponent(resolveCaptureFileName(templateId, imageName), {
      fallback: 'capture',
      sanitize: sanitizeFileName
    });
    const runDir = await ensureSafeDirectory(capturesDir, [resolvedRunId]);
    const tableDir = await ensureSafeDirectory(capturesDir, [resolvedRunId, safeTaskName, safeTableName]);
    const imagePath = resolvePathWithin(tableDir, `${safeImageName}.png`);
    const folderPath = path.relative(rootDir, runDir).split(path.sep).join('/');
    const imageFolderPath = path.relative(rootDir, tableDir).split(path.sep).join('/');
    resolvePathWithin(rootDir, folderPath);
    resolvePathWithin(rootDir, imageFolderPath);
    const rowsForReport = result.rows.slice(0, maxCaptureRows);
    const returnedRowCount = result.rows.length;
    const queryTruncated = Boolean(result.truncated);
    const captureTruncated = returnedRowCount > rowsForReport.length;

    if (claimedImagePaths.has(imagePath)) {
      throw createClientError('该运行中已存在同名截图任务。', 409);
    }
    try {
      await fsp.lstat(imagePath);
      throw createClientError('该运行中已存在同名截图文件。', 409);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    const html = buildReportHtml({
      title: taskName,
      table,
      tableComment,
      sql,
      columns: result.columns,
      rows: rowsForReport,
      hideSql: Boolean(captureOptions?.hideSql),
      showTableMeta: Boolean(captureOptions?.showTableMeta),
      queryTruncated,
      captureTruncated,
      returnedRowCount,
      cellCharacterLimit: result.cellCharacterLimit
    });

    const captureController = new AbortController();
    const captureDeadline = Date.now() + CAPTURE_TASK_TIMEOUT_MS;
    claimedImagePaths.add(imagePath);
    try {
      const captureOperation = typeof captureScreenshotImpl === 'function'
        ? captureScreenshotImpl
        : captureScreenshot;
      await withTimeout(
        () => captureOperation(
          html,
          imagePath,
          result.columns.length,
          rowsForReport.length + 2,
          validatedProfileKey,
          { deadline: captureDeadline, signal: captureController.signal }
        ),
        CAPTURE_TASK_TIMEOUT_MS,
        '截图任务执行超时。',
        () => {
          captureController.abort(createCaptureCancelledError('CAPTURE_DEADLINE_EXCEEDED'));
          shutdownBrowserSessions().catch(() => {});
        }
      );
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw createClientError('该运行中已存在同名截图文件。', 409);
      }
      if ([408, 409, 429].includes(error?.statusCode)) {
        throw error;
      }
      const captureError = error instanceof Error ? error : new Error('截图任务失败。');
      const htmlPath = await persistFailureDiagnostic(html, {
        runId: resolvedRunId,
        safeTaskName,
        safeTableName
      }).catch(() => '');
      if (htmlPath) {
        Object.defineProperty(captureError, 'internalHtmlPath', {
          configurable: true,
          enumerable: false,
          value: htmlPath
        });
        captureError.message = `${captureError.message} 报告页面已在内部保留供诊断。`;
      } else {
        captureError.message = `${captureError.message} 报告页面保留失败。`;
      }
      throw captureError;
    } finally {
      if (!captureController.signal.aborted) {
        captureController.abort(createCaptureCancelledError());
      }
      claimedImagePaths.delete(imagePath);
    }

    return {
      runId: resolvedRunId,
      folderPath,
      imageFolderPath,
      imagePath,
      truncated: queryTruncated || captureTruncated,
      queryTruncated,
      captureTruncated,
      capturedRowCount: rowsForReport.length,
      returnedRowCount
    };
  }

  async function shutdownBrowserSessions() {
    const trackedSessions = new Set([...browserSessions.values(), ...stoppingSessions]);
    await Promise.all(Array.from(trackedSessions, (session) => session.stop().catch(() => {})));
  }

  function resolveAllowedFolderPath(inputPath) {
    const raw = String(inputPath || '').trim();
    if (!raw) {
      const error = new Error('请指定要打开的目录路径。');
      error.statusCode = 400;
      throw error;
    }

    const absolute = path.resolve(rootDir, raw);
    const allowedRoots = [capturesDir, path.join(rootDir, 'logs'), tmpDir];
    const inAllowedRoot = allowedRoots.some((root) => {
      const relative = path.relative(root, absolute);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });

    if (!inAllowedRoot) {
      const error = new Error('该路径不在允许打开的目录内。');
      error.statusCode = 400;
      throw error;
    }

    if (fs.existsSync(absolute)) {
      const realAbsolute = fs.realpathSync.native(absolute);
      const realRootDir = fs.realpathSync.native(rootDir);
      const inRealAllowedRoot = allowedRoots.some((root) => {
        if (!fs.existsSync(root)) {
          return false;
        }
        const rootStat = fs.lstatSync(root);
        const realAllowedRoot = fs.realpathSync.native(root);
        return !rootStat.isSymbolicLink()
          && isPathWithin(realRootDir, realAllowedRoot)
          && isPathWithin(realAllowedRoot, realAbsolute);
      });
      if (!inRealAllowedRoot) {
        throw createClientError('该路径通过符号链接指向允许目录之外。');
      }
      return realAbsolute;
    }

    return absolute;
  }

  async function openFolder(absolute) {
    const opener = platform === 'win32'
      ? 'explorer.exe'
      : platform === 'darwin'
        ? 'open'
        : 'xdg-open';
    const child = spawnProcess(opener, [absolute], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    await withTimeout(
      new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      }),
      OPEN_FOLDER_TIMEOUT_MS,
      '启动目录窗口超时。',
      () => {
        try {
          child.kill?.();
        } catch {}
      }
    );
    child.on('error', () => {});
    child.unref();
  }

  return {
    createArtifact,
    findBrowser,
    openFolder,
    resolveAllowedFolderPath,
    shutdownBrowserSessions,
    warmupCaptureSession
  };
}

module.exports = {
  BoundedDeadlineQueue,
  CAPTURE_HARD_LIMITS,
  assertActiveRegistryEntry,
  atomicWriteFile,
  cleanupExpiredEntries,
  createCaptureService,
  createRunId,
  countTrackedCaptureSessions,
  deleteRegistryEntryIfCurrent,
  enforceSessionCapacity,
  isRetryableCaptureError,
  normalizeCaptureClip,
  normalizeCaptureLimits,
  resolvePathWithin,
  sanitizePathComponent,
  validateCaptureProfileKey,
  validateRunId,
  withTimeout
};
