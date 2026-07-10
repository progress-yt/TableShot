/* global module */
(function exposeTableShotCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.TableShotCore = api;
  }
}(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';

  function createRequestCoordinator(AbortControllerClass = globalThis.AbortController) {
    if (typeof AbortControllerClass !== 'function') {
      throw new TypeError('AbortController is required');
    }

    const active = new Map();
    let generation = 0;

    function begin(scope) {
      const key = String(scope || 'default');
      active.get(key)?.controller.abort();
      const controller = new AbortControllerClass();
      const token = ++generation;
      const entry = { controller, token };
      active.set(key, entry);

      return {
        signal: controller.signal,
        token,
        abort() {
          controller.abort();
        },
        isCurrent() {
          return active.get(key) === entry && !controller.signal.aborted;
        },
        finish() {
          if (active.get(key) === entry) {
            active.delete(key);
          }
        }
      };
    }

    function abort(scope) {
      const key = String(scope || 'default');
      const entry = active.get(key);
      if (!entry) return false;
      active.delete(key);
      entry.controller.abort();
      return true;
    }

    function abortAll() {
      for (const entry of active.values()) {
        entry.controller.abort();
      }
      active.clear();
    }

    return { begin, abort, abortAll };
  }

  function createRunLock() {
    let isLocked = false;

    return {
      get locked() {
        return isLocked;
      },
      tryAcquire() {
        if (isLocked) return null;
        isLocked = true;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          isLocked = false;
        };
      }
    };
  }

  function createRunLedger(ids) {
    const statuses = new Map();
    for (const rawId of ids || []) {
      const id = String(rawId);
      if (!statuses.has(id)) statuses.set(id, 'queued');
    }

    function transition(id, next, allowed) {
      const key = String(id);
      const current = statuses.get(key);
      if (!allowed.includes(current)) return false;
      statuses.set(key, next);
      return true;
    }

    function cancelQueued() {
      let count = 0;
      for (const [id, status] of statuses) {
        if (status === 'queued') {
          statuses.set(id, 'cancelled');
          count += 1;
        }
      }
      return count;
    }

    function counts() {
      const result = {
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        settled: 0,
        total: statuses.size
      };
      for (const status of statuses.values()) {
        result[status] += 1;
      }
      result.settled = result.succeeded + result.failed + result.cancelled;
      return result;
    }

    return {
      cancelQueued,
      counts,
      getStatus(id) {
        return statuses.get(String(id));
      },
      markRunning(id) {
        return transition(id, 'running', ['queued']);
      },
      markSucceeded(id) {
        return transition(id, 'succeeded', ['running']);
      },
      markFailed(id) {
        return transition(id, 'failed', ['running']);
      },
      markCancelled(id) {
        return transition(id, 'cancelled', ['queued', 'running']);
      }
    };
  }

  function paginate(items, requestedPage = 1, requestedPageSize = 100) {
    const source = Array.isArray(items) ? items : [];
    const pageSize = Math.min(250, Math.max(1, Math.trunc(Number(requestedPageSize)) || 100));
    const pageCount = Math.max(1, Math.ceil(source.length / pageSize));
    const page = Math.min(pageCount, Math.max(1, Math.trunc(Number(requestedPage)) || 1));
    const start = (page - 1) * pageSize;
    return {
      items: source.slice(start, start + pageSize),
      page,
      pageCount,
      pageSize,
      start,
      total: source.length
    };
  }

  async function mapWithConcurrency(items, requestedConcurrency, mapper) {
    if (typeof mapper !== 'function') throw new TypeError('mapper must be a function');
    const source = Array.isArray(items) ? items : [];
    if (!source.length) return [];
    const concurrency = Math.min(
      source.length,
      Math.max(1, Math.trunc(Number(requestedConcurrency)) || 1)
    );
    const results = new Array(source.length);
    let nextIndex = 0;
    let failure = null;

    const worker = async () => {
      while (!failure && nextIndex < source.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await mapper(source[index], index);
        } catch (error) {
          failure = error;
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (failure) throw failure;
    return results;
  }

  function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function buildQueryRequest(input = {}) {
    const fields = {};
    const timeField = cleanString(input.fields?.timeField);
    const regionField = cleanString(input.fields?.regionField);
    if (timeField) fields.timeField = timeField;
    if (regionField) fields.regionField = regionField;

    const request = {
      database: cleanString(input.database),
      table: cleanString(input.table),
      templateId: cleanString(input.templateId),
      fields,
      capture: Boolean(input.capture),
      taskName: cleanString(input.taskName),
      runId: cleanString(input.runId),
      captureProfileKey: cleanString(input.captureProfileKey)
    };

    return request;
  }

  function requireCaptureArtifact(payload) {
    const artifact = payload?.artifact;
    if (!artifact || typeof artifact !== 'object') {
      throw new Error('服务端未返回截图产物，任务已按失败处理。');
    }
    const imagePath = cleanString(artifact.imagePath);
    const folderPath = cleanString(artifact.folderPath);
    if (!imagePath) {
      throw new Error('服务端截图产物缺少图片路径，任务已按失败处理。');
    }
    if (!folderPath) {
      throw new Error('服务端截图产物缺少输出目录，任务已按失败处理。');
    }
    if (typeof artifact.truncated !== 'boolean') {
      throw new Error('服务端截图产物缺少截断状态，任务已按失败处理。');
    }
    const capturedRowCount = artifact.capturedRowCount;
    const totalRowCount = artifact.totalRowCount;
    if (!Number.isInteger(capturedRowCount) || capturedRowCount < 0) {
      throw new Error('服务端截图产物的已截图行数无效，任务已按失败处理。');
    }
    if (!Number.isInteger(totalRowCount) || totalRowCount < capturedRowCount) {
      throw new Error('服务端截图产物的总行数无效，任务已按失败处理。');
    }
    const returnedRowCount = Number.isInteger(artifact.returnedRowCount)
      ? artifact.returnedRowCount
      : totalRowCount;
    if (returnedRowCount < capturedRowCount || totalRowCount < returnedRowCount) {
      throw new Error('服务端截图产物的返回行数无效，任务已按失败处理。');
    }
    const queryTruncated = artifact.queryTruncated === true;
    const captureTruncated = artifact.captureTruncated === true || capturedRowCount < returnedRowCount;
    if (artifact.truncated !== (queryTruncated || captureTruncated)) {
      throw new Error('服务端截图产物的截断状态与行数不一致，任务已按失败处理。');
    }
    return {
      imagePath,
      folderPath,
      truncated: artifact.truncated,
      queryTruncated,
      captureTruncated,
      capturedRowCount,
      returnedRowCount,
      totalRowCount
    };
  }

  function describeCaptureCompleteness(artifact = {}) {
    const capturedRowCount = Math.max(0, Math.trunc(Number(artifact.capturedRowCount)) || 0);
    const returnedRowCount = Math.max(
      capturedRowCount,
      Math.trunc(Number(artifact.returnedRowCount)) || Math.trunc(Number(artifact.totalRowCount)) || 0
    );
    const queryTruncated = artifact.queryTruncated === true;
    const captureTruncated = artifact.captureTruncated === true || capturedRowCount < returnedRowCount;

    if (queryTruncated) {
      const summary = captureTruncated
        ? `截图展示前 ${capturedRowCount} 行；服务端返回 ${returnedRowCount} 行且查询已达上限，实际结果可能更多。`
        : `截图展示服务端返回的 ${returnedRowCount} 行；查询已达上限，实际结果可能更多。`;
      return {
        summary,
        warningTitle: captureTruncated ? '查询与截图范围受限' : '查询结果范围受限',
        warningMessage: '请勿将该图片或当前受限的查询响应视为完整结果集。'
      };
    }

    if (captureTruncated) {
      return {
        summary: `截图仅包含前 ${capturedRowCount}/${returnedRowCount} 行。`,
        warningTitle: '截图行数受限',
        warningMessage: '图片未包含本次查询返回的全部行；请勿将其视为完整结果集。'
      };
    }

    return {
      summary: `截图包含本次查询返回的全部 ${returnedRowCount} 行。`,
      warningTitle: '',
      warningMessage: ''
    };
  }

  function describePreviewCompleteness(preview = {}) {
    const rows = Array.isArray(preview.rows) ? preview.rows : [];
    const columns = Array.isArray(preview.columns) ? preview.columns : [];
    const truncatedRows = preview.truncatedRows === true;
    const truncatedColumns = preview.truncatedColumns === true;
    const returnedColumnCount = Number.isInteger(preview.returnedColumnCount)
      ? preview.returnedColumnCount
      : columns.length;
    const totalColumnCount = Number.isInteger(preview.totalColumnCount)
      ? Math.max(returnedColumnCount, preview.totalColumnCount)
      : returnedColumnCount;
    const notices = [];

    if (truncatedRows) {
      notices.push(`仅展示前 ${rows.length} 行，表中还有更多数据`);
    }
    if (truncatedColumns) {
      notices.push(`仅展示前 ${returnedColumnCount}/${totalColumnCount} 个字段`);
    }
    if (Number.isInteger(preview.cellCharacterLimit) && preview.cellCharacterLimit > 0) {
      notices.push(`文本单元格最多展示前 ${preview.cellCharacterLimit} 个字符`);
    }
    if (preview.binaryValuesSummarized === true) {
      notices.push('二进制字段仅显示字节数摘要');
    }

    return {
      summary: truncatedRows
        ? `已加载前 ${rows.length} 行（仍有更多），点击展开查看`
        : `已加载 ${rows.length} 行，点击展开查看`,
      notices
    };
  }

  function describeQueryCompleteness(result = {}) {
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const truncated = result.truncated === true;
    const notices = [];
    if (truncated) {
      notices.push(`仅返回前 ${rows.length} 行，实际结果可能更多`);
    }
    if (Number.isInteger(result.cellCharacterLimit) && result.cellCharacterLimit > 0) {
      notices.push(`文本值最多保留前 ${result.cellCharacterLimit} 个字符`);
    }
    return {
      summary: truncated
        ? `查询完成，返回前 ${rows.length} 行；查询已达上限，实际结果可能更多。`
        : `查询完成，返回 ${rows.length} 行。`,
      notices
    };
  }

  function createRunId(cryptoObject = globalThis.crypto, now = Date.now) {
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
      return cryptoObject.randomUUID();
    }
    return `run-${now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function isAbortError(error) {
    return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
  }

  return {
    buildQueryRequest,
    createRequestCoordinator,
    createRunId,
    createRunLedger,
    createRunLock,
    describeCaptureCompleteness,
    describePreviewCompleteness,
    describeQueryCompleteness,
    isAbortError,
    mapWithConcurrency,
    paginate,
    requireCaptureArtifact
  };
}));
