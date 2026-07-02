const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function createCaptureService(options) {
  const {
    rootDir,
    capturesDir,
    tmpDir,
    maxCaptureRows,
    maxCaptureWidth,
    maxCaptureHeight,
    minCaptureWidth,
    minCaptureHeight,
    sanitizeFileName,
    resolveCaptureFileName,
    ensureDirectories
  } = options;

  const BROWSER_SESSION_IDLE_MS = 5 * 60 * 1000;
  const BROWSER_SESSION_START_TIMEOUT_MS = 10 * 1000;
  const PAGE_EVENT_TIMEOUT_MS = 15 * 1000;
  const MAX_BROWSER_OUTPUT_CHARS = 4000;
  const CAPTURE_FONT_READY_TIMEOUT_MS = 120;
  const CAPTURE_DEVICE_SCALE_FACTOR = 2;
  const browserSessions = new Map();

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
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
    if (process.platform === 'win32') {
      return [
        { name: 'Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
        { name: 'Edge', path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
        { name: 'Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
        { name: 'Chrome', path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' }
      ];
    }

    if (process.platform === 'darwin') {
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
    if (process.platform === 'win32') {
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
      const result = spawnSync('which', [candidate.command], { encoding: 'utf8' });
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
    return path.join(
      tmpDir,
      'browser-profile',
      `${sanitizeFileName(browserName).toLowerCase()}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
  }

  function resolveCaptureProfileDir(browserName, captureProfileKey) {
    const key = String(captureProfileKey || '').trim();
    if (!key) {
      return { path: createCaptureProfileDir(browserName), reusable: false };
    }

    return {
      path: path.join(tmpDir, 'browser-profile', sanitizeFileName(browserName).toLowerCase(), sanitizeFileName(key)),
      reusable: true
    };
  }

  function normalizeCaptureClip(measured, viewport) {
    return {
      x: 0,
      y: 0,
      width: clampNumber(Math.ceil(Number(measured.width) || viewport.width), minCaptureWidth, maxCaptureWidth),
      height: clampNumber(Math.ceil(Number(measured.height) || viewport.height), minCaptureHeight, maxCaptureHeight),
      scale: 1
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

    return normalizeCaptureClip(response?.result?.value || {}, viewport);
  }

  function canRetryCaptureWithDefaultEncoding(error) {
    return /optimizeForSpeed|Invalid parameters|Unknown parameter|Unexpected parameter/i.test(String(error?.message || ''));
  }

  async function capturePng(connection, clip) {
    const params = { format: 'png', fromSurface: true, captureBeyondViewport: true, clip };
    try {
      return await connection.send('Page.captureScreenshot', { ...params, optimizeForSpeed: true });
    } catch (error) {
      if (!canRetryCaptureWithDefaultEncoding(error)) {
        throw error;
      }
    }
    return connection.send('Page.captureScreenshot', params);
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
            const { resolve: resolvePending, reject: rejectPending } = this.pending.get(payload.id);
            this.pending.delete(payload.id);
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

    send(method, params = {}) {
      const id = this.nextId;
      this.nextId += 1;
      const payload = JSON.stringify({ id, method, params });

      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.ws.send(payload);
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
      this.pending.forEach(({ reject }) => reject(error));
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
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
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
      this.stopped = false;
      this.targetId = '';
      this.frameId = '';
      this.connection = null;
      this.captureQueue = Promise.resolve();
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

    async ensureStarted() {
      if (this.startPromise) {
        return this.startPromise;
      }

      this.stopped = false;
      this.startPromise = (async () => {
        await fsp.mkdir(this.profileDir, { recursive: true });
        await this.sweepStaleLocks();
        await new Promise((resolve, reject) => {
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
            browserSessions.delete(this.sessionKey);
            if (!settled) {
              const reason = signal
                ? `浏览器调试会话被信号 ${signal} 终止。`
                : `浏览器调试会话退出，状态码 ${code}。`;
              rejectOnce(new Error(buildCaptureFailureMessage(this.browser.name, reason, this.browserOutput)));
            }
          });
        });

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
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.stop().catch(() => {});
      }, BROWSER_SESSION_IDLE_MS);
    }

    async createTarget(url) {
      const targetUrl = `${this.httpBase}/json/new?${encodeURIComponent(url)}`;
      let response = await fetch(targetUrl, { method: 'PUT' }).catch(() => null);
      if (!response || !response.ok) {
        response = await fetch(targetUrl).catch(() => null);
      }
      if (!response || !response.ok) {
        const statusText = response ? `状态码 ${response.status}` : '请求未建立';
        throw new Error(buildCaptureFailureMessage(this.browser.name, `浏览器页面创建失败，${statusText}。`, this.browserOutput));
      }
      return response.json();
    }

    async closeTarget(targetId) {
      if (!targetId) {
        return;
      }
      await fetch(`${this.httpBase}/json/close/${encodeURIComponent(targetId)}`).catch(() => {});
    }

    async capture(html, imagePath, viewport) {
      const previousCapture = this.captureQueue;
      let releaseCapture = null;
      this.captureQueue = new Promise((resolve) => {
        releaseCapture = resolve;
      });

      await previousCapture.catch(() => {});

      try {
        await this.ensureStarted();
        clearTimeout(this.idleTimer);

        if (!this.connection || !this.frameId) {
          throw new Error(buildCaptureFailureMessage(this.browser.name, 'capture session is not ready.', this.browserOutput));
        }

        await this.connection.send('Emulation.setDeviceMetricsOverride', {
          mobile: false,
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR
        });
        await this.connection.send('Page.setDocumentContent', { frameId: this.frameId, html });
        const clip = await waitForCaptureClip(this.connection, viewport);
        const screenshot = await capturePng(this.connection, clip);
        if (!screenshot?.data) {
          throw new Error(buildCaptureFailureMessage(this.browser.name, 'capture completed without PNG data.', this.browserOutput));
        }
        const imageBuffer = Buffer.from(screenshot.data, 'base64');
        if (!imageBuffer.length) {
          throw new Error(buildCaptureFailureMessage(this.browser.name, 'capture completed with empty PNG data.', this.browserOutput));
        }
        await fsp.writeFile(imagePath, imageBuffer);
        return imageBuffer.length;
      } catch (error) {
        await this.stop().catch(() => {});
        throw error;
      } finally {
        releaseCapture();
        if (browserSessions.has(this.sessionKey)) {
          this.scheduleStop();
        }
      }
    }

    async stop() {
      if (this.stopped) {
        return;
      }
      this.stopped = true;
      clearTimeout(this.idleTimer);
      browserSessions.delete(this.sessionKey);
      if (this.connection) {
        try {
          this.connection.close();
        } catch {}
        this.connection = null;
      }
      const child = this.child;
      this.child = null;
      this.startPromise = null;
      if (child && !child.killed && child.pid) {
        if (process.platform === 'win32') {
          await new Promise((resolve) => {
            const killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
            const done = () => resolve();
            killer.once('exit', done);
            killer.once('error', done);
          });
        } else {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
        await wait(500);
      }
      await fsp.rm(this.profileDir, { recursive: true, force: true }).catch(() => {});
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

  function getBrowserSession(browser, profileDir, captureProfileKey) {
    const sessionKey = `${browser.path}:${captureProfileKey}`;
    if (!browserSessions.has(sessionKey)) {
      browserSessions.set(sessionKey, new BrowserSession(sessionKey, browser, profileDir));
    }
    return browserSessions.get(sessionKey);
  }

  async function warmupCaptureSession(captureProfileKey) {
    const browser = findBrowser();
    if (!browser) {
      const error = new Error('未检测到可用于截图的浏览器，无法执行截图预热。');
      error.statusCode = 500;
      throw error;
    }
    const profile = resolveCaptureProfileDir(browser.name, captureProfileKey);
    const session = getBrowserSession(browser, profile.path, String(captureProfileKey || '').trim());
    await session.ensureStarted();
    session.scheduleStop();
  }

  function buildReportHtml({ title, table, tableComment, sql, columns, rows, hideSql, showTableMeta }) {
    const safeColumns = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
    const safeTableName = escapeHtml(table || title || '-');
    const safeTableComment = escapeHtml(tableComment || '暂无中文注释');
    const roomyTable = columns.length <= 2;
    const tableMinWidth = roomyTable ? 640 : 0;
    const cellMaxWidth = roomyTable ? 680 : 320;
    const safeRows = rows.length
      ? rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] === null ? 'NULL' : row[column])}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${Math.max(columns.length, 1)}">No rows returned</td></tr>`;

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
  </style>
</head>
<body>
  <div class="sheet">
    ${showTableMeta ? `<section class="table-meta"><p class="table-meta-label">目标表</p><p class="table-meta-name">${safeTableName}</p><p class="table-meta-comment">${safeTableComment}</p></section>` : ''}
    ${hideSql ? '' : `<section class="section"><p class="section-label">查询语句</p><pre class="sql">${escapeHtml(sql)}</pre></section>`}
    <section class="section"><p class="section-label">查询结果</p><div class="table-wrap">${columns.length ? `<table><thead><tr>${safeColumns}</tr></thead><tbody>${safeRows}</tbody></table>` : `<div class="empty">No rows returned</div>`}</div></section>
  </div>
</body>
</html>`;
  }

  function calculateViewport(columnsCount, rowsCount) {
    return {
      width: clampNumber(Math.max(220 * Math.max(columnsCount, 1), 720), minCaptureWidth, maxCaptureWidth),
      height: clampNumber(180 + rowsCount * 42, minCaptureHeight, maxCaptureHeight)
    };
  }

  async function captureScreenshot(html, imagePath, columnsCount, rowsCount, captureProfileKey) {
    const browser = findBrowser();
    if (!browser) {
      const error = new Error('未检测到可用于截图的浏览器，无法执行自动截图。');
      error.statusCode = 500;
      throw error;
    }

    const viewport = calculateViewport(columnsCount, rowsCount);
    const profile = resolveCaptureProfileDir(browser.name, captureProfileKey);
    const profileDir = profile.path;
    const captureSessionKey = profile.reusable ? String(captureProfileKey || '').trim() : profileDir;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const captureSession = getBrowserSession(browser, profileDir, captureSessionKey);
      try {
        const imageBytes = await captureSession.capture(html, imagePath, viewport);
        if (!imageBytes || imageBytes <= 0) {
          throw new Error(buildCaptureFailureMessage(browser.name, '截图结束后没有生成有效的 PNG 文件。', captureSession.browserOutput));
        }
        if (!profile.reusable) {
          await captureSession.stop().catch(() => {});
        }
        return;
      } catch (error) {
        await captureSession.stop().catch(() => {});
        const retryable = attempt < maxAttempts && /状态码 21/.test(String(error?.message || ''));
        if (!retryable) {
          throw error;
        }
        await wait(400);
      }
    }
  }

  function buildCaptureUrl(imagePath) {
    const relativePath = path.relative(capturesDir, imagePath);
    return `/captures/${relativePath.split(path.sep).map((segment) => encodeURIComponent(segment)).join('/')}`;
  }

  async function createArtifact({ taskName, templateId, imageName, table, tableComment, sql, result, captureProfileKey, captureOptions }) {
    await ensureDirectories();

    const safeTaskName = sanitizeFileName(taskName);
    const safeTableName = sanitizeFileName(table || 'single-query');
    const safeImageName = sanitizeFileName(resolveCaptureFileName(templateId, imageName));
    const stamp = nowStamp();
    const taskDir = path.join(capturesDir, safeTaskName);
    const tableDir = path.join(taskDir, safeTableName);
    const htmlPath = path.join(tmpDir, `${stamp}-${safeTaskName}-${safeTableName}.html`);
    const imagePath = path.join(tableDir, `${safeImageName}.png`);
    const rowsForReport = result.rows.slice(0, maxCaptureRows);

    await fsp.mkdir(tableDir, { recursive: true });

    const html = buildReportHtml({
      title: taskName,
      table,
      tableComment,
      sql,
      columns: result.columns,
      rows: rowsForReport,
      hideSql: Boolean(captureOptions?.hideSql),
      showTableMeta: Boolean(captureOptions?.showTableMeta)
    });

    try {
      await captureScreenshot(html, imagePath, result.columns.length, rowsForReport.length + 2, captureProfileKey);
    } catch (error) {
      let htmlSaved = false;
      await fsp.writeFile(htmlPath, html, 'utf8').then(() => {
        htmlSaved = true;
      }).catch(() => {});
      error.message = htmlSaved
        ? `${error.message} 报告页面已保留在 ${htmlPath}`
        : `${error.message} 报告页面保留失败，请检查目录 ${tmpDir}`;
      throw error;
    }

    return {
      imagePath,
      imageUrl: buildCaptureUrl(imagePath)
    };
  }

  async function shutdownBrowserSessions() {
    await Promise.all(Array.from(browserSessions.values()).map((session) => session.stop().catch(() => {})));
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

    return absolute;
  }

  async function openFolder(absolute) {
    if (process.platform === 'win32') {
      const child = spawn('explorer.exe', [absolute], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => {});
      child.unref();
      return;
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(opener, [absolute], { detached: true, stdio: 'ignore' });
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
  createCaptureService
};
