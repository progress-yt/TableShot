const STORAGE_KEYS = {
  tasks: 'mysql-capture-tasks',
  sql: 'mysql-capture-sql',
  templateId: 'mysql-capture-template-id',
  fieldOverrides: 'mysql-capture-field-overrides'
};

const TIME_FIELD_CANDIDATES = [
  'created_time',
  'create_time',
  'created_at',
  'create_at',
  'record_time',
  'record_date',
  'date',
  'stat_date',
  'data_date',
  'update_time',
  'updated_at'
];
const TIME_FIELD_NAME_PATTERN = /(^|_)(create|created|record|stat|update|updated|start|end|begin|finish|time|date)(_|$)/;
const TIME_FIELD_COMMENT_PATTERN = /(时间|日期|时段|开始|结束|统计时间|记录时间)/;
const REGION_AUTO_FIELD_CANDIDATES = ['region', 'region_name', 'area', 'area_name', 'district', 'zone'];
const REGION_FIELD_CANDIDATES = [
  'region',
  'region_name',
  'area',
  'area_name',
  'district',
  'zone',
  'province',
  'province_name',
  'city',
  'city_name',
  'county',
  'county_name',
  'town',
  'town_name',
  'township',
  'street',
  'village',
  'community',
  'location_town',
  'location_county',
  'location_city',
  'location_area',
  'location_region'
];
const REGION_FIELD_NAME_PATTERN = /(^|_)(region|area|district|zone|province|city|county|town|township|street|village|community)(_|$)/;
const REGION_FIELD_COMMENT_PATTERN = /(区域|地区|省|市|县|区|镇|乡|街道|村|社区)/;
const REGION_FIELD_EXCLUDE_PATTERN = /(^|_)(id|hash|md5|sha1|sha256|uuid|guid|token|salt|pwd|password|create|created|update|updated|delete|deleted|time|date)(_|$)/;

const QUERY_TEMPLATES = [
  { id: 'time-range', name: '查询时间范围', description: '自动识别时间字段并返回最早与最晚日期' },
  { id: 'region-distribution', name: '查询区域分布', description: '自动识别区域字段并列出区域值' },
  { id: 'total-rows', name: '查询总行数', description: '统计当前表总行数，并显示表名称' },
  { id: 'table-structure', name: '查询表结构', description: '查看当前表的字段、类型、默认值和注释' },
  { id: 'storage-usage', name: '查询存储空间', description: '查看当前表的存储空间占用（执行前会自动刷新统计信息）' }
];

const DEFAULT_SQL = '-- 请先选择一张表';
const BATCH_CONCURRENCY_HARD_CAP = 6;

function getBatchConcurrency(taskCount) {
  const cores = Number(navigator.hardwareConcurrency) || 4;
  const cpuCap = Math.max(2, Math.floor(cores / 2));
  const upper = Math.min(cpuCap, BATCH_CONCURRENCY_HARD_CAP);
  return Math.max(1, Math.min(Number(taskCount) || 0, upper));
}
const PREVIEW_MODE = new URLSearchParams(window.location.search).has('preview');

const state = {
  batchAbortControllers: new Set(),
  batchCancelRequested: false,
  batchCancelledCount: 0,
  batchCompleted: 0,
  batchFailures: 0,
  batchModalCollapsed: false,
  batchStartedAt: 0,
  batchTasksOverride: null,
  batchRunning: false,
  batchTotal: 0,
  columns: [],
  connection: null,
  currentDatabase: '',
  currentTable: '',
  currentTemplateId: QUERY_TEMPLATES[0].id,
  databases: [],
  fieldOverrides: {},
  preview: { columns: [], rows: [] },
  result: { columns: [], rows: [] },
  runContext: null,
  runEntries: [],
  runStats: { success: 0, warning: 0, failure: 0, total: 0, durationMs: 0, tables: new Set() },
  selectedTables: new Set(),
  tables: [],
  tasks: []
};

const elements = {
  runSummaryPane: document.getElementById('runSummaryPane'),
  runDetailsPane: document.getElementById('runDetailsPane'),
  runFolderBadge: document.getElementById('runFolderBadge'),
  batchConfirmModal: document.getElementById('batchConfirmModal'),
  batchModalCancelButton: document.getElementById('batchModalCancelButton'),
  batchModalCloseButton: document.getElementById('batchModalCloseButton'),
  batchModalConfirmButton: document.getElementById('batchModalConfirmButton'),
  batchModalStopButton: document.getElementById('batchModalStopButton'),
  batchProgressDock: document.getElementById('batchProgressDock'),
  batchProgressDockToggle: document.getElementById('batchProgressDockToggle'),
  batchProgressDockStopButton: document.getElementById('batchProgressDockStopButton'),
  batchProgressDockText: document.getElementById('batchProgressDockText'),
  batchModalSummary: document.getElementById('batchModalSummary'),
  batchModalTables: document.getElementById('batchModalTables'),
  batchProgressFill: document.getElementById('batchProgressFill'),
  batchProgressText: document.getElementById('batchProgressText'),
  batchRunInfo: document.getElementById('batchRunInfo'),
  browserBadge: document.getElementById('statusBrowser'),
  clearSelectedTablesButton: document.getElementById('clearSelectedTablesButton'),
  clearTasksButton: document.getElementById('clearTasksButton'),
  columnsCountLabel: document.getElementById('columnsCountLabel'),
  columnsPane: document.getElementById('columnsPane'),
  connectionBadge: document.getElementById('connectionBadge'),
  connectionMeta: document.getElementById('connectionMeta'),
  currentDatabaseLabel: document.getElementById('currentDatabaseLabel'),
  currentTableLabel: document.getElementById('currentTableLabel'),
  databaseSelect: document.getElementById('databaseSelect'),
  heroDatabaseLabel: document.getElementById('heroDatabaseLabel'),
  optionalPreviewDisclosure: document.getElementById('optionalPreviewDisclosure'),
  heroTargetCount: document.getElementById('heroTargetCount'),
  previewCountLabel: document.getElementById('previewCountLabel'),
  previewDisclosure: document.getElementById('previewDisclosure'),
  previewLimitInput: document.getElementById('previewLimitInput'),
  previewPane: document.getElementById('previewPane'),
  previewSummaryText: document.getElementById('previewSummaryText'),
  progressStep1: document.getElementById('progressStep1'),
  progressStep2: document.getElementById('progressStep2'),
  progressStep3: document.getElementById('progressStep3'),
  progressText1: document.getElementById('progressText1'),
  progressText2: document.getElementById('progressText2'),
  progressText3: document.getElementById('progressText3'),
  refreshTablesButton: document.getElementById('refreshTablesButton'),
  resultCountLabel: document.getElementById('resultCountLabel'),
  resultPane: document.getElementById('resultPane'),
  copySelectedSqlButton: document.getElementById('copySelectedSqlButton'),
  copySelectedSqlButtonNoStructure: document.getElementById('copySelectedSqlButtonNoStructure'),
  runAndCaptureButton: document.getElementById('runAndCaptureButton'),
  runQueryButton: document.getElementById('runQueryButton'),
  runTasksButton: document.getElementById('runTasksButton'),
  saveTaskButton: document.getElementById('saveTaskButton'),
  selectAllTablesButton: document.getElementById('selectAllTablesButton'),
  selectedTableCountPill: document.getElementById('selectedTableCountPill'),
  sqlEditor: document.getElementById('sqlEditor'),
  sqlTemplateList: document.getElementById('sqlTemplateList'),
  editorCard: document.querySelector('.editor-card'),
  statusBar: document.getElementById('statusBar'),
  toastMessage: document.getElementById('toastMessage'),
  statusConnection: document.getElementById('statusConnection'),
  statusOutput: document.getElementById('statusOutput'),
  statusSelection: document.getElementById('statusSelection'),
  tableSelect: document.getElementById('tableSelect'),
  taskCountLabel: document.getElementById('taskCountLabel'),
  taskNameInput: document.getElementById('taskNameInput'),
  taskTableChecklist: document.getElementById('taskTableChecklist'),
  tasksPane: document.getElementById('tasksPane'),
  stepAutomation: document.getElementById('stepAutomation'),
  stepAutomationState: document.getElementById('stepAutomationState'),
  stepConnect: document.getElementById('stepConnect'),
  stepConnectState: document.getElementById('stepConnectState'),
  stepQuery: document.getElementById('stepQuery'),
  stepQueryState: document.getElementById('stepQueryState')
};

let templateInferenceHint = null;
let templateFieldControl = null;
let templateFieldLabel = null;
let templateFieldSelect = null;
let templateFieldHint = null;
let toastTimer = null;

function api(url, options = {}) {
  return fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.message || `请求失败: ${response.status}`);
      error.payload = payload;
      throw error;
    }
    return payload;
  });
}

async function retryRequest(fn, attempts = 2, delayMs = 350) {
  let lastError = null;

  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (index === attempts - 1) {
        break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

function getTemplateById(templateId) {
  return QUERY_TEMPLATES.find((item) => item.id === templateId) || QUERY_TEMPLATES[0];
}

function getTableInfo(tableName = state.currentTable) {
  return state.tables.find((item) => item.tableName === tableName) || null;
}

function getCurrentColumnsForTable(tableName) {
  return tableName && tableName === state.currentTable ? state.columns : [];
}

function getFieldOverrideKey(tableName, database = state.currentDatabase) {
  return `${database || ''}::${tableName || ''}`;
}

function getFieldOverrides(tableName, database = state.currentDatabase) {
  return state.fieldOverrides[getFieldOverrideKey(tableName, database)] || {};
}

function persistFieldOverrides() {
  localStorage.setItem(STORAGE_KEYS.fieldOverrides, JSON.stringify(state.fieldOverrides));
}

function setFieldOverride(tableName, role, value, database = state.currentDatabase) {
  const key = getFieldOverrideKey(tableName, database);
  const next = { ...(state.fieldOverrides[key] || {}) };
  if (value) {
    next[role] = value;
    state.fieldOverrides[key] = next;
  } else {
    delete next[role];
    if (Object.keys(next).length) {
      state.fieldOverrides[key] = next;
    } else {
      delete state.fieldOverrides[key];
    }
  }
  persistFieldOverrides();
}

function dedupeFieldNames(names) {
  const seen = new Set();
  return names.filter((name) => {
    const key = String(name || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isTimeCandidateColumn(column) {
  const name = String(column?.columnName || '').toLowerCase();
  const type = String(column?.columnType || '').toLowerCase();
  const comment = String(column?.columnComment || '').trim();
  if (!name) return false;
  if (/(blob|binary|varbinary|json)/.test(type)) {
    return false;
  }
  return /(date|time|timestamp|datetime)/.test(type)
    || TIME_FIELD_CANDIDATES.includes(name)
    || TIME_FIELD_NAME_PATTERN.test(name)
    || TIME_FIELD_COMMENT_PATTERN.test(comment);
}

function buildFieldCandidates(columns) {
  const timeFields = dedupeFieldNames(
    columns
      .filter((column) => isTimeCandidateColumn(column))
      .map((column) => column.columnName)
  );

  const regionFields = dedupeFieldNames(
    columns
      .filter((column) => {
        const name = String(column.columnName || '').toLowerCase();
        const type = String(column.columnType || '').toLowerCase();
        const comment = String(column.columnComment || '').trim();
        if (REGION_FIELD_EXCLUDE_PATTERN.test(name)) {
          return false;
        }
        if (/(blob|binary|varbinary|json)/.test(type)) {
          return false;
        }
        return REGION_FIELD_CANDIDATES.includes(name)
          || REGION_FIELD_NAME_PATTERN.test(name)
          || REGION_FIELD_COMMENT_PATTERN.test(comment);
      })
      .map((column) => column.columnName)
  );

  return { timeFields, regionFields };
}

function getTemplateFieldRequirement(templateId) {
  if (templateId === 'time-range') {
    return { role: 'timeField', label: '时间字段', candidateKey: 'timeFields' };
  }
  if (templateId === 'region-distribution') {
    return { role: 'regionField', label: '区域字段', candidateKey: 'regionFields' };
  }
  return null;
}

function getTemplateFieldState(templateId, tableName = state.currentTable) {
  const requirement = getTemplateFieldRequirement(templateId);
  if (!requirement || !tableName) return null;

  const tableInfo = getTableInfo(tableName);
  const columns = getCurrentColumnsForTable(tableName);
  const timeColumns = columns.filter((column) => isTimeCandidateColumn(column));
  const fieldCandidates = columns.length
    ? buildFieldCandidates(columns)
    : (tableInfo?.fieldCandidates || { timeFields: [], regionFields: [] });
  const overrides = getFieldOverrides(tableName);
  const manualField = overrides[requirement.role] || '';
  const autoField = requirement.role === 'timeField'
    ? (tableInfo?.detectedFields?.timeField
      || detectField(timeColumns, TIME_FIELD_CANDIDATES, /(date|time|timestamp|datetime)/, TIME_FIELD_NAME_PATTERN))
    : (tableInfo?.detectedFields?.regionField
      || detectField(columns, REGION_AUTO_FIELD_CANDIDATES, null));
  const candidates = dedupeFieldNames([
    ...fieldCandidates[requirement.candidateKey],
    autoField,
    manualField
  ]);
  return {
    ...requirement,
    autoField,
    manualField,
    candidates,
    activeField: manualField || autoField || '',
    needsManualSelection: !autoField && !manualField && candidates.length > 0
  };
}

function getTemplateAvailability(tableOrName, templateId) {
  const tableInfo = typeof tableOrName === 'string' ? getTableInfo(tableOrName) : tableOrName;
  const tableName = typeof tableOrName === 'string' ? tableOrName : tableInfo?.tableName;
  const fieldState = getTemplateFieldState(templateId, tableName);
  if (fieldState?.manualField) {
    return { supported: true, field: fieldState.manualField, source: 'manual' };
  }
  return tableInfo?.templateAvailability?.[templateId] || { supported: true };
}

function isTemplateSupported(tableOrName, templateId) {
  return getTemplateAvailability(tableOrName, templateId).supported !== false;
}

function getTemplateSkipReason(tableOrName, templateId) {
  const availability = getTemplateAvailability(tableOrName, templateId);
  return availability.reason || '当前模板不适用于该表。';
}

function formatTaskTitle(task, tableInfo = getTableInfo(task.tableName), template = getTemplateById(task.templateId)) {
  return `${task.folderName} / ${tableInfo?.tableName || task.tableName} / ${template.name}`;
}

function formatDuration(durationMs) {
  const safeMs = Math.max(0, Math.round(Number(durationMs) || 0));
  if (safeMs < 1000) {
    return `${safeMs} ms`;
  }
  return `${(safeMs / 1000).toFixed(safeMs >= 10000 ? 0 : 1)} s`;
}

async function copyTextToClipboard(text) {
  const content = String(text || '');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = content;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function detectField(columns, candidates, typePattern, namePattern) {
  if (!Array.isArray(columns) || !columns.length) return null;

  for (const candidate of candidates) {
    const matched = columns.find((column) => String(column.columnName || '').toLowerCase() === candidate);
    if (matched) return matched.columnName;
  }

  if (namePattern) {
    const matched = columns.find((column) => namePattern.test(String(column.columnName || '').toLowerCase()));
    if (matched) return matched.columnName;
  }

  if (typePattern) {
    const matched = columns.find((column) => typePattern.test(String(column.columnType || '').toLowerCase()));
    if (matched) return matched.columnName;
  }

  return null;
}

function resolveTemplateContext(templateId, tableName = state.currentTable) {
  const columns = getCurrentColumnsForTable(tableName);
  const overrides = getFieldOverrides(tableName);
  const timeColumns = columns.filter((column) => isTimeCandidateColumn(column));
  const timeField =
    overrides.timeField
    || getTableInfo(tableName)?.detectedFields?.timeField
    || detectField(
      timeColumns,
      TIME_FIELD_CANDIDATES,
      /(date|time|timestamp|datetime)/,
      TIME_FIELD_NAME_PATTERN
    );
  const regionField =
    overrides.regionField
    || getTableInfo(tableName)?.detectedFields?.regionField
    || detectField(
      columns,
      REGION_AUTO_FIELD_CANDIDATES,
      null
    );
  const fieldState = getTemplateFieldState(templateId, tableName);

  return {
    timeField,
    regionField,
    fieldState
  };
}

function escapeIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function escapeLiteral(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function buildTemplateSql(templateId, database, tableName, tableComment = '') {
  if (!database || !tableName) return DEFAULT_SQL;
  const targetTable = `${escapeIdentifier(tableName)}`;
  const label = tableComment && String(tableComment).trim() ? String(tableComment).trim() : tableName;
  const context = resolveTemplateContext(templateId, tableName);
  switch (templateId) {
    case 'time-range':
      if (!context.timeField) {
        return context.fieldState?.candidates?.length
          ? '-- 当前模板未自动识别到时间字段，请先从上方候选字段中手动选择'
          : '-- 当前表未检测到可用时间字段';
      }
      return ['SELECT',`    DATE(MIN(${escapeIdentifier(context.timeField)})) AS earliest_record,`,`    DATE(MAX(${escapeIdentifier(context.timeField)})) AS latest_record`,`FROM ${targetTable};`].join('\n');
    case 'region-distribution':
      if (!context.regionField) {
        return context.fieldState?.candidates?.length
          ? '-- 当前模板未自动识别到区域字段，请先从上方候选字段中手动选择'
          : '-- 当前表未检测到可用区域字段';
      }
      return [`SELECT DISTINCT ${escapeIdentifier(context.regionField)}`,`FROM ${targetTable};`].join('\n');
    case 'total-rows':
      return ['SELECT',`    ${escapeLiteral(label)} AS 表名称,`,'    COUNT(1) AS 总行数',`FROM ${targetTable};`].join('\n');
    case 'table-structure':
      return [
        'SELECT',
        '    ORDINAL_POSITION AS 序号,',
        '    COLUMN_NAME AS 字段名,',
        '    COLUMN_TYPE AS 类型,',
        "    CASE WHEN IS_NULLABLE = 'YES' THEN '是' ELSE '否' END AS 可空,",
        "    COALESCE(COLUMN_DEFAULT, 'NULL') AS 默认值,",
        "    COALESCE(NULLIF(COLUMN_COMMENT, ''), '暂无字段注释') AS 注释",
        'FROM information_schema.COLUMNS',
        'WHERE TABLE_SCHEMA = DATABASE()',
        `  AND TABLE_NAME = ${escapeLiteral(tableName)}`,
        'ORDER BY ORDINAL_POSITION;'
      ].join('\n');
    case 'storage-usage':
      return [
        'SELECT',
        '    CONCAT(',
        `        ${escapeLiteral(`${label}当前占用 `)},`,
        '        ROUND(SUM(data_length + index_length) / 1024 / 1024, 2),',
        "        'MB 存储空间'",
        '    ) AS table_description',
        'FROM information_schema.TABLES',
        'WHERE table_schema = DATABASE()',
        `  AND table_name = ${escapeLiteral(tableName)};`
      ].join('\n');
    default:
      return DEFAULT_SQL;
  }
}

function updateSqlPreview() {
  const tableInfo = getTableInfo();
  elements.sqlEditor.value = buildTemplateSql(state.currentTemplateId, state.currentDatabase, tableInfo?.tableName || '', tableInfo?.tableComment || '');
  localStorage.setItem(STORAGE_KEYS.templateId, state.currentTemplateId);
  localStorage.setItem(STORAGE_KEYS.sql, elements.sqlEditor.value);
  renderTemplateInferenceHint();
  renderTemplateFieldControl();
}

function getTemplateFieldSummary(templateId, tableName = state.currentTable) {
  const fieldState = getTemplateFieldState(templateId, tableName);
  if (!fieldState) {
    return '';
  }
  if (fieldState.manualField) {
    return `${fieldState.label}：${fieldState.manualField}（手动指定）`;
  }
  if (fieldState.autoField) {
    return `${fieldState.label}：${fieldState.autoField}（自动识别）`;
  }
  if (fieldState.candidates.length) {
    return `${fieldState.label}候选：${fieldState.candidates.join('、')}`;
  }
  return `未识别到可用${fieldState.label}`;
}

function ensureTemplateInferenceHint() {
  if (templateInferenceHint || !elements.sqlEditor) return;
  templateInferenceHint = document.createElement('p');
  templateInferenceHint.className = 'field-hint template-inline-hint';
  elements.sqlEditor.insertAdjacentElement('afterend', templateInferenceHint);
}

function renderTemplateInferenceHint() {
  ensureTemplateInferenceHint();
  if (!templateInferenceHint) return;

  const template = getTemplateById(state.currentTemplateId);
  const tableInfo = getTableInfo();
  const fieldSummary = getTemplateFieldSummary(state.currentTemplateId, tableInfo?.tableName);
  if (!fieldSummary) {
    templateInferenceHint.hidden = true;
    return;
  }

  templateInferenceHint.hidden = false;
  templateInferenceHint.textContent = tableInfo
    ? `${template.name} · ${tableInfo.tableName} · ${fieldSummary}`
    : `${template.name} · ${fieldSummary}`;
}

function ensureTemplateFieldControl() {
  if (templateFieldControl || !elements.editorCard) return;
  templateFieldControl = document.createElement('label');
  templateFieldControl.className = 'template-field-control';
  templateFieldLabel = document.createElement('span');
  templateFieldSelect = document.createElement('select');
  templateFieldHint = document.createElement('small');
  templateFieldHint.className = 'field-hint';
  templateFieldSelect.addEventListener('change', () => {
    const fieldState = getTemplateFieldState(state.currentTemplateId);
    if (!fieldState || !state.currentTable) return;
    const value = templateFieldSelect.value;
    if (value === '__auto__' || !value) {
      setFieldOverride(state.currentTable, fieldState.role, '');
      setStatus(`已恢复 ${state.currentTable} 的${fieldState.label}自动识别。`);
    } else {
      setFieldOverride(state.currentTable, fieldState.role, value);
      setStatus(`已将 ${state.currentTable} 的${fieldState.label}设置为 ${value}。`);
    }
    updateSqlPreview();
    renderTasks();
    updateStepStates();
  });
  templateFieldControl.append(templateFieldLabel, templateFieldSelect, templateFieldHint);
  const anchor = templateInferenceHint || elements.sqlEditor;
  anchor.insertAdjacentElement('afterend', templateFieldControl);
}

function renderTemplateFieldControl() {
  ensureTemplateInferenceHint();
  ensureTemplateFieldControl();
  if (!templateFieldControl || !templateFieldLabel || !templateFieldSelect || !templateFieldHint) return;

  const fieldState = getTemplateFieldState(state.currentTemplateId);
  if (!fieldState || !state.currentTable) {
    templateFieldControl.hidden = true;
    return;
  }

  if (!fieldState.candidates.length && !fieldState.autoField && !fieldState.manualField) {
    templateFieldControl.hidden = true;
    return;
  }

  templateFieldControl.hidden = false;
  templateFieldLabel.textContent = `${fieldState.label}选择`;
  templateFieldSelect.innerHTML = '';

  if (fieldState.autoField) {
    const autoOption = document.createElement('option');
    autoOption.value = '__auto__';
    autoOption.textContent = `自动识别：${fieldState.autoField}`;
    templateFieldSelect.appendChild(autoOption);
  } else {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `请选择${fieldState.label}`;
    templateFieldSelect.appendChild(placeholder);
  }

  fieldState.candidates.forEach((fieldName) => {
    const option = document.createElement('option');
    option.value = fieldName;
    option.textContent = fieldName;
    templateFieldSelect.appendChild(option);
  });

  templateFieldSelect.value = fieldState.manualField || (fieldState.autoField ? '__auto__' : '');
  templateFieldHint.textContent = fieldState.needsManualSelection
    ? `未自动识别到${fieldState.label}。这里只展示可能相关的字段，请手动选择。`
    : fieldState.autoField && fieldState.candidates.length > 1
      ? `当前已自动识别为 ${fieldState.autoField}，如果不合适可以改选其他候选字段。`
      : `如自动识别不符合预期，可以在这里手动覆盖 ${fieldState.label}。`;
}

function loadTasks() {
  localStorage.removeItem(STORAGE_KEYS.tasks);
  return [];
}

function saveTasks() {
  localStorage.removeItem(STORAGE_KEYS.tasks);
}

function clearTaskQueue(options = {}) {
  const { silent = false, source = '' } = options;
  const clearedCount = state.tasks.length;
  if (!clearedCount) {
    if (!silent) {
      setStatus('当前没有可清空的任务。');
    }
    return 0;
  }
  state.tasks = [];
  state.batchTasksOverride = null;
  saveTasks();
  renderTasks();
  updateStepStates();
  if (!silent) {
    setStatus(
      source === 'database-switch'
        ? `已因切换数据库清空 ${clearedCount} 个任务。`
        : `已清空 ${clearedCount} 个任务。`,
      'success'
    );
  }
  return clearedCount;
}

function setStatus(message, type = 'neutral') {
  elements.statusBar.textContent = message;
  elements.statusBar.dataset.type = type;

  if (!elements.toastMessage) return;

  elements.toastMessage.textContent = message;
  elements.toastMessage.dataset.type = type;
  elements.toastMessage.classList.add('is-visible');

  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }

  toastTimer = window.setTimeout(() => {
    elements.toastMessage.classList.remove('is-visible');
  }, 2400);
}

function setTooltip(node, text) {
  node.dataset.tip = text;
  node.title = text;
}

function setStatusIcon(node, active) {
  node.classList.toggle('is-active', Boolean(active));
}

function setConnectionBadge(connected) {
  elements.connectionBadge.textContent = connected ? '已连接' : '未连接';
  elements.connectionBadge.className = connected ? 'status-chip is-connected' : 'status-chip';
}

function setConnectionMeta(connection) {
  elements.connectionMeta.textContent = connection ? `${connection.user}@${connection.host}:${connection.port}` : '当前没有数据库连接，请返回登录页重新连接。';
}
function updateCurrentTableLabel() {
  elements.currentDatabaseLabel.textContent = state.currentDatabase || '未选择';
  elements.currentTableLabel.textContent = state.currentTable || '未选择';
}

function setStepState(panel, badge, stateName, text) {
  panel.classList.remove('is-pending', 'is-ready', 'is-done');
  panel.classList.add(`is-${stateName}`);
  badge.className = `step-state is-${stateName}`;
  badge.textContent = text;
}

function setProgressState(item, textNode, stateName, text) {
  item.classList.remove('is-pending', 'is-ready', 'is-done');
  item.classList.add(`is-${stateName}`);
  textNode.textContent = text;
}

function updateStepStates() {
  const hasDatabase = Boolean(state.currentDatabase);
  const hasTable = getSelectedTableInfos().length > 0;
  const hasPreview = Boolean(state.columns.length || state.preview.rows.length);
  const hasQuery = Boolean(state.result.rows.length || state.result.columns.length);
  const enabledTaskCount = state.tasks.filter((task) => task.enabled).length;
  const hasTask = enabledTaskCount > 0;
  const hasOutput = state.runStats.success > 0;

  setStepState(elements.stepConnect, elements.stepConnectState, hasDatabase && hasTable ? 'done' : hasDatabase ? 'ready' : 'pending', hasDatabase && hasTable ? '已选目标表' : hasDatabase ? '已选库' : '待完成');
  setStepState(elements.stepQuery, elements.stepQueryState, hasQuery ? 'done' : hasPreview ? 'ready' : 'pending', hasQuery ? '已查询' : hasPreview ? '已预览' : '待完成');
  setStepState(elements.stepAutomation, elements.stepAutomationState, hasOutput ? 'done' : hasTask ? 'ready' : 'pending', hasOutput ? '已输出' : hasTask ? '可执行' : '待完成');

  const selectedCount = getSelectedTableInfos().length;
  setProgressState(elements.progressStep1, elements.progressText1, hasDatabase && hasTable ? 'done' : hasDatabase ? 'ready' : 'pending', hasDatabase && hasTable ? `${selectedCount} 张目标表` : hasDatabase ? `已选数据库 ${state.currentDatabase}` : '等待开始');
  setProgressState(elements.progressStep2, elements.progressText2, hasQuery ? 'done' : hasPreview ? 'ready' : 'pending', hasQuery ? `单表试跑完成` : hasPreview ? `已加载预览` : '可选步骤');
  setProgressState(elements.progressStep3, elements.progressText3, hasOutput ? 'done' : hasTask ? 'ready' : 'pending', hasOutput ? `已生成 ${state.runStats.success} 张截图` : hasTask ? `${enabledTaskCount} 个任务待执行` : '等待配置');

  setStatusIcon(elements.statusConnection, Boolean(state.connection));
  setStatusIcon(elements.statusSelection, hasDatabase && hasTable);
  setStatusIcon(elements.statusOutput, hasOutput);
  setTooltip(elements.statusConnection, state.connection ? `已连接 ${state.connection.user}@${state.connection.host}:${state.connection.port}` : '当前没有数据库连接');
  setTooltip(elements.statusSelection, hasDatabase && hasTable ? `当前已选 ${selectedCount} 张目标表` : hasDatabase ? `已选择数据库 ${state.currentDatabase}，尚未勾选目标表` : '请先选择数据库和目标表');
  setTooltip(elements.statusOutput, hasOutput ? `已经生成 ${state.runStats.success} 张本地截图` : hasTask ? '任务已配置，执行后会生成本地截图' : '尚未生成截图输出');
  renderWorkflowSummary();
}

function setBrowserStatus(status) {
  const available = status === 'available';
  setStatusIcon(elements.browserBadge, available);
  setTooltip(elements.browserBadge, available ? '截图浏览器可用' : '未检测到 Edge 或 Chrome');
}

function buildTable(rows, columns, className = 'data-table') {
  const table = document.createElement('table');
  table.className = className;
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach((column) => {
    const th = document.createElement('th');
    th.textContent = column;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    columns.forEach((column) => {
      const td = document.createElement('td');
      const value = row[column];
      td.textContent = value === null || value === undefined ? 'NULL' : String(value);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
  return table;
}

function renderColumns() {
  elements.columnsCountLabel.textContent = `${state.columns.length} 个字段`;
  if (!state.columns.length) {
    elements.columnsPane.className = 'data-pane empty-state';
    elements.columnsPane.textContent = '选择表后显示字段结构。';
    return;
  }
  elements.columnsPane.className = 'data-pane';
  const rows = state.columns.map((column, index) => ({
    '序号': column.ordinalPosition || index + 1,
    '字段名': column.columnName,
    '类型': column.columnType,
    '可空': column.isNullable === 'YES' ? '是' : '否',
    '默认值': column.columnDefault ?? 'NULL',
    '注释': column.columnComment || '暂无字段注释'
  }));
  elements.columnsPane.replaceChildren(buildTable(rows, ['序号', '字段名', '类型', '可空', '默认值', '注释'], 'data-table columns-table'));
}

function renderPreview() {
  elements.previewCountLabel.textContent = `${state.preview.rows.length} 行`;
  if (!state.preview.rows.length) {
    elements.previewDisclosure.open = false;
    elements.previewSummaryText.textContent = '未加载预览数据';
    elements.previewPane.className = 'data-pane empty-state';
    elements.previewPane.textContent = '选择表后显示预览数据。';
    return;
  }
  elements.previewDisclosure.open = false;
  elements.previewSummaryText.textContent = `已加载 ${state.preview.rows.length} 行，点击展开查看`;
  elements.previewPane.className = 'data-pane';
  elements.previewPane.replaceChildren(buildTable(state.preview.rows, state.preview.columns, 'data-table data-table-navicat'));
}

function renderResult() {
  elements.resultCountLabel.textContent = `${state.result.rows.length} 行`;
  if (!state.result.rows.length) {
    elements.resultPane.className = 'data-pane empty-state';
    elements.resultPane.textContent = '执行 SQL 后显示结果。';
    return;
  }
  elements.resultPane.className = 'data-pane';
  elements.resultPane.replaceChildren(buildTable(state.result.rows, state.result.columns));
}

function renderDatabaseOptions() {
  elements.databaseSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = state.databases.length ? '请选择数据库' : '没有可用数据库';
  elements.databaseSelect.appendChild(placeholder);
  state.databases.forEach((database) => {
    const option = document.createElement('option');
    option.value = database;
    option.textContent = database;
    elements.databaseSelect.appendChild(option);
  });
  elements.databaseSelect.value = state.currentDatabase && state.databases.includes(state.currentDatabase) ? state.currentDatabase : '';
  elements.databaseSelect.disabled = !state.databases.length;
}

function renderTableSelects() {
  elements.tableSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = state.tables.length ? '请选择要查看的表' : '没有可用表';
  elements.tableSelect.appendChild(placeholder);
  state.tables.forEach((table) => {
    const option = document.createElement('option');
    option.value = table.tableName;
    option.textContent = table.tableName;
    elements.tableSelect.appendChild(option);
  });
  elements.tableSelect.disabled = !state.tables.length;
  elements.tableSelect.value = state.currentTable && state.tables.some((table) => table.tableName === state.currentTable) ? state.currentTable : '';
  renderTaskTableChecklist();
}
function renderTaskTableChecklist() {
  if (!state.tables.length) {
    elements.taskTableChecklist.className = 'task-table-checklist empty-state';
    elements.taskTableChecklist.textContent = '选择数据库后显示可选操作对象。';
    return;
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'task-table-checklist';
  state.tables.forEach((table) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `task-table-option${state.selectedTables.has(table.tableName) ? ' is-selected' : ''}`;
    const check = document.createElement('span');
    check.className = 'task-table-option-check';
    check.textContent = state.selectedTables.has(table.tableName) ? '✓' : '';
    const body = document.createElement('span');
    body.className = 'task-table-option-body';
    const title = document.createElement('strong');
    title.className = 'task-table-option-title';
    title.textContent = table.tableName;
    const note = document.createElement('span');
    note.className = 'task-table-option-note';
    note.textContent = table.tableComment ? String(table.tableComment).trim() : '暂无表注释';
    body.append(title, note);
    button.append(check, body);
    button.addEventListener('click', () => {
      if (state.selectedTables.has(table.tableName)) state.selectedTables.delete(table.tableName);
      else state.selectedTables.add(table.tableName);
      renderTaskTableChecklist();
      updateStepStates();
    });
    wrapper.appendChild(button);
  });
  elements.taskTableChecklist.className = '';
  elements.taskTableChecklist.replaceChildren(wrapper);
}

function getSelectedTableInfos() {
  return state.tables.filter((table) => state.selectedTables.has(table.tableName));
}

function buildSelectedTablesSqlScript(options = {}) {
  const excludeIds = new Set(options.excludeTemplateIds || []);
  const templates = QUERY_TEMPLATES.filter((template) => !excludeIds.has(template.id));

  const selectedTables = getSelectedTableInfos()
    .slice()
    .sort((left, right) => left.tableName.localeCompare(right.tableName, 'zh-CN'));

  if (!state.currentDatabase) {
    throw new Error('请先选择数据库。');
  }

  if (!selectedTables.length) {
    throw new Error('请先勾选至少一张目标表。');
  }

  if (!templates.length) {
    throw new Error('当前没有可用的模板（已全部被排除）。');
  }

  const sections = [
    `-- Database: ${state.currentDatabase}`,
    `USE ${escapeIdentifier(state.currentDatabase)};`,
    ''
  ];

  let executableCount = 0;
  const issues = [];

  selectedTables.forEach((tableInfo, tableIndex) => {
    if (tableIndex > 0) {
      sections.push('');
    }

    sections.push(`-- ===== Table: ${tableInfo.tableName}${tableInfo.tableComment ? ` (${String(tableInfo.tableComment).trim()})` : ''} =====`);

    templates.forEach((template) => {
      const sql = buildTemplateSql(template.id, state.currentDatabase, tableInfo.tableName, tableInfo.tableComment || '');
      sections.push(`-- [${template.name}]`);
      sections.push(sql);
      sections.push('');
      if (!sql.startsWith('--')) {
        executableCount += 1;
        return;
      }

      issues.push({
        tableName: tableInfo.tableName,
        templateName: template.name,
        reason: sql.slice(3).trim() || '当前模板不可执行'
      });
    });
  });

  return {
    script: sections.join('\n').trim(),
    tableCount: selectedTables.length,
    blockCount: selectedTables.length * templates.length,
    templateCount: templates.length,
    executableCount,
    issues
  };
}

async function copySelectedTablesSqlScript(options = {}) {
  const payload = buildSelectedTablesSqlScript(options);
  await copyTextToClipboard(payload.script);
  const suffix = options.label ? `（${options.label}）` : '';
  if (payload.issues.length) {
    const issueSummary = payload.issues
      .map((issue) => `表 ${issue.tableName} / ${issue.templateName}: ${issue.reason}`)
      .join('\n');
    window.alert(
      `已复制 ${payload.tableCount} 张表的 ${payload.blockCount} 段模板脚本${suffix}。\n\n其中 ${payload.issues.length} 段当前不可执行，定位如下：\n${issueSummary}`
    );
    setStatus(
      `已复制 ${payload.tableCount} 张表的 ${payload.blockCount} 段模板脚本${suffix}，其中 ${payload.executableCount} 段可直接执行；不可执行原因已提示。`,
      'error'
    );
    return;
  }

  setStatus(`已复制 ${payload.tableCount} 张表的 ${payload.blockCount} 段模板脚本${suffix}，全部可直接执行。`, 'success');
}

function renderPillList(target, items, emptyText) {
  if (!target) return;
  if (!items.length) {
    target.className = 'pill-list empty-state';
    target.textContent = emptyText;
    return;
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'pill-list';
  items.forEach((item) => {
    const pill = document.createElement('span');
    pill.className = 'summary-pill';
    pill.textContent = item;
    wrapper.appendChild(pill);
  });
  target.className = '';
  target.replaceChildren(wrapper);
}

function renderWorkflowSummary() {
  const selectedTables = getSelectedTableInfos();
  const enabledTasks = state.tasks.filter((task) => task.enabled);
  const queueTables = new Set(enabledTasks.map((task) => task.tableName));
  const templateCountText = `${QUERY_TEMPLATES.length} 个模板`;

  if (elements.heroDatabaseLabel) {
    elements.heroDatabaseLabel.textContent = state.currentDatabase || '未选择数据库';
  }
  if (elements.heroTargetCount) {
    elements.heroTargetCount.textContent = `${selectedTables.length} 张目标表`;
  }
  if (elements.selectedTableCountPill) {
    elements.selectedTableCountPill.textContent = `${selectedTables.length} 张目标表`;
  }
  if (elements.batchRunInfo) {
    elements.batchRunInfo.textContent =
      enabledTasks.length
        ? `已生成 ${enabledTasks.length} 个任务，覆盖 ${queueTables.size} 张表。可直接批量执行。`
        : selectedTables.length
          ? `已选 ${selectedTables.length} 张目标表。点击“生成批量任务”后自动展开。`
          : '请先勾选至少一张目标表，再生成批量任务。';
  }
  if (elements.copySelectedSqlButton) {
    elements.copySelectedSqlButton.disabled = !state.currentDatabase || !selectedTables.length;
    const copyTip = !state.currentDatabase
      ? '请先选择数据库'
      : selectedTables.length
        ? `复制当前数据库中 ${selectedTables.length} 张已选表的 ${templateCountText} SQL`
        : '请先勾选至少一张目标表';
    elements.copySelectedSqlButton.dataset.tip = copyTip;
    elements.copySelectedSqlButton.title = copyTip;
  }
  if (elements.copySelectedSqlButtonNoStructure) {
    elements.copySelectedSqlButtonNoStructure.disabled = !state.currentDatabase || !selectedTables.length;
    const copyTipNoStructure = !state.currentDatabase
      ? '请先选择数据库'
      : selectedTables.length
        ? `复制 ${selectedTables.length} 张已选表的模板 SQL（不含表结构查询）`
        : '请先勾选至少一张目标表';
    elements.copySelectedSqlButtonNoStructure.dataset.tip = copyTipNoStructure;
    elements.copySelectedSqlButtonNoStructure.title = copyTipNoStructure;
  }
  if (elements.clearTasksButton) {
    elements.clearTasksButton.disabled = !state.tasks.length || state.batchRunning;
  }
}

function hasResettablePageState() {
  return Boolean(
    state.batchRunning
    || state.selectedTables.size
    || state.tasks.length
    || state.runStats.success
    || state.result.rows.length
    || state.result.columns.length
    || state.preview.rows.length
    || state.preview.columns.length
    || state.currentTable
    || elements.taskNameInput.value.trim()
  );
}

function syncBatchActionButtons() {
  if (elements.runTasksButton) {
    elements.runTasksButton.disabled = state.batchRunning;
    elements.runTasksButton.textContent =
      state.batchRunning
        ? state.batchCancelRequested ? '正在结束批量任务...' : '批量执行中...'
        : '批量执行并截图';
  }
  if (elements.batchModalConfirmButton) {
    elements.batchModalConfirmButton.disabled = state.batchRunning;
    elements.batchModalConfirmButton.textContent = state.batchRunning ? '执行中...' : '确认执行';
  }
  if (elements.batchModalCancelButton) {
    elements.batchModalCancelButton.textContent = state.batchRunning ? '收起' : '取消';
  }
  if (elements.batchModalCloseButton) {
    elements.batchModalCloseButton.textContent = state.batchRunning ? '收起' : '关闭';
  }
  if (elements.batchModalStopButton) {
    elements.batchModalStopButton.hidden = !state.batchRunning;
    elements.batchModalStopButton.disabled = !state.batchRunning || state.batchCancelRequested;
    elements.batchModalStopButton.textContent = state.batchCancelRequested ? '结束处理中...' : '提前结束任务';
  }
  if (elements.batchProgressDockStopButton) {
    elements.batchProgressDockStopButton.disabled = !state.batchRunning || state.batchCancelRequested;
    elements.batchProgressDockStopButton.textContent = state.batchCancelRequested ? '结束处理中...' : '提前结束';
  }
}

function updateBatchProgressUi(text = '尚未开始') {
  if (elements.batchProgressText) {
    elements.batchProgressText.textContent = text;
  }
  if (elements.batchProgressDockText) {
    elements.batchProgressDockText.textContent = text;
  }
}

function syncBatchProgressDock() {
  if (!elements.batchProgressDock) return;
  const visible = state.batchRunning && state.batchModalCollapsed;
  elements.batchProgressDock.classList.toggle('is-hidden', !visible);
}

function resetBatchRuntimeState() {
  state.batchAbortControllers.forEach((controller) => controller.abort());
  state.batchAbortControllers.clear();
  state.batchCancelRequested = false;
  state.batchCancelledCount = 0;
  state.batchCompleted = 0;
  state.batchFailures = 0;
  state.batchStartedAt = 0;
  state.batchTotal = 0;
}

function requestBatchCancellation() {
  if (!state.batchRunning || state.batchCancelRequested) {
    return;
  }
  const confirmed = window.confirm('提前结束后，将停止未开始任务，并尝试中断当前请求。已经提交到数据库或浏览器的截图任务可能仍会继续完成，已生成的图片和日志也会保留。是否继续？');
  if (!confirmed) {
    return;
  }
  state.batchCancelRequested = true;
  state.batchAbortControllers.forEach((controller) => controller.abort());
  syncBatchActionButtons();
  updateBatchProgressUi(
    `正在提前结束... 已完成 ${state.batchCompleted}/${state.batchTotal || 0}，失败 ${state.batchFailures} 个`
  );
  setStatus('已请求提前结束批量任务。未开始的任务将停止调度，已发出的任务可能仍会继续完成。', 'error');
}

function collapseBatchModal() {
  if (!state.batchRunning || !elements.batchConfirmModal) return;
  state.batchModalCollapsed = true;
  elements.batchConfirmModal.classList.add('is-hidden');
  elements.batchConfirmModal.setAttribute('aria-hidden', 'true');
  syncBatchProgressDock();
}

function expandBatchModal() {
  if (!state.batchRunning || !elements.batchConfirmModal) return;
  state.batchModalCollapsed = false;
  elements.batchConfirmModal.classList.remove('is-hidden');
  elements.batchConfirmModal.setAttribute('aria-hidden', 'false');
  syncBatchProgressDock();
}

function closeBatchModal(force = false) {
  if (state.batchRunning && !force) {
    collapseBatchModal();
    return;
  }
  if (!elements.batchConfirmModal) return;
  elements.batchConfirmModal.classList.add('is-hidden');
  elements.batchConfirmModal.setAttribute('aria-hidden', 'true');
  state.batchModalCollapsed = false;
  state.batchTasksOverride = null;
  resetBatchRuntimeState();
  syncBatchActionButtons();
  syncBatchProgressDock();
}

function openBatchModal() {
  const tasks = state.batchTasksOverride || state.tasks.filter((task) => task.enabled);
  if (!tasks.length) {
    setStatus('请先生成至少一个批量任务。', 'error');
    return;
  }

  const taskTableNames = [...new Set(tasks.map((task) => task.tableName))];
  renderPillList(elements.batchModalTables, taskTableNames, '暂无数据');
  elements.batchModalSummary.textContent = `当前数据库 ${state.currentDatabase}，将执行 ${tasks.length} 个具体任务，覆盖 ${taskTableNames.length} 张表。确认后会按“任务模板文件夹/表名文件夹/图片名称.png”的结构批量保存 PNG，失败项会在下方输出记录中显示原因和本地日志路径。`;
  elements.batchProgressFill.style.width = '0%';
  state.batchModalCollapsed = false;
  state.batchCancelRequested = false;
  state.batchCancelledCount = 0;
  state.batchTotal = tasks.length;
  state.batchCompleted = 0;
  state.batchFailures = 0;
  updateBatchProgressUi('尚未开始');
  syncBatchActionButtons();
  syncBatchProgressDock();
  elements.batchConfirmModal.classList.remove('is-hidden');
  elements.batchConfirmModal.setAttribute('aria-hidden', 'false');
}

async function analyzeTableRequest(tableName) {
  const controller = new AbortController();
  state.batchAbortControllers.add(controller);
  try {
    await api('/api/analyze-table', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({
        database: state.currentDatabase,
        table: tableName
      })
    });
  } finally {
    state.batchAbortControllers.delete(controller);
  }
}

async function runAnalyzePhase(tableNames, queryTaskCount) {
  const total = tableNames.length;
  let done = 0;
  const ANALYZE_CONCURRENCY = 2;
  let nextIndex = 0;

  const updateAnalyzeProgress = () => {
    updateBatchProgressUi(
      state.batchCancelRequested
        ? `统计信息刷新中 · ${done}/${total} · 正在提前结束`
        : `正在刷新统计信息 ${done}/${total}（随后将执行 ${queryTaskCount} 个查询任务）`
    );
  };
  updateAnalyzeProgress();

  const runAnalyzeWorker = async () => {
    while (nextIndex < total && !state.batchCancelRequested) {
      const tableName = tableNames[nextIndex];
      nextIndex += 1;
      try {
        await analyzeTableRequest(tableName);
      } catch (error) {
        if (!state.batchCancelRequested) {
          const details = describeApiError(error);
          const fallbackDetail = details.message && details.message !== details.reason
            ? `${details.message} 查询存储空间仍会继续执行，但返回结果可能基于旧统计值。`
            : '查询存储空间仍会继续执行，但返回结果可能基于旧统计值。';
          appendRunEntry({
            kind: 'warning',
            title: `统计信息刷新 / ${tableName}`,
            tableName,
            templateName: 'ANALYZE TABLE',
            reason: details.reason || details.message || '刷新统计信息失败。',
            logPath: details.logPath,
            message: fallbackDetail
          });
          console.warn('analyze-table failed', tableName, error);
        }
      } finally {
        done += 1;
        updateAnalyzeProgress();
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(ANALYZE_CONCURRENCY, total) }, () => runAnalyzeWorker())
  );
}

async function executeBatchRun() {
  const tasks = state.batchTasksOverride || state.tasks.filter((task) => task.enabled);
  if (!tasks.length) {
    setStatus('没有可执行的批量任务。', 'error');
    return;
  }

  state.batchRunning = true;
  state.batchTotal = tasks.length;
  state.batchCompleted = 0;
  state.batchFailures = 0;
  state.batchCancelledCount = 0;
  state.batchCancelRequested = false;
  state.batchStartedAt = performance.now();
  syncBatchActionButtons();

  const firstFolderName = tasks.find((task) => task.folderName)?.folderName || elements.taskNameInput?.value?.trim() || '';
  beginRun({ folderName: firstFolderName, kind: 'batch' });

  const analyzeTargets = [...new Set(
    tasks.filter((task) => task.templateId === 'storage-usage').map((task) => task.tableName)
  )];

  if (analyzeTargets.length && !state.batchCancelRequested) {
    await runAnalyzePhase(analyzeTargets, tasks.length);
  }

  const concurrency = getBatchConcurrency(tasks.length);
  updateBatchProgressUi(`0 / ${tasks.length} · 准备执行（并发 ${concurrency}）`);

  let nextIndex = 0;

  const executeSingleTask = async (job, workerId) => {
    const startedAt = performance.now();
    const tableInfo = getTableInfo(job.tableName) || { tableName: job.tableName, tableComment: '' };
    const sql = buildTemplateSql(job.templateId, state.currentDatabase, tableInfo.tableName, tableInfo.tableComment || '');
    const template = getTemplateById(job.templateId);
    const taskTitle = formatTaskTitle(job, tableInfo, template);

    if (sql.startsWith('--')) {
      state.batchFailures += 1;
      state.batchCompleted += 1;
      elements.batchProgressFill.style.width = `${(state.batchCompleted / tasks.length) * 100}%`;
      updateBatchProgressUi(`${state.batchCompleted} / ${tasks.length} · 跳过 ${tableInfo.tableName}`);
      appendRunEntry({
        kind: 'error',
        title: taskTitle,
        tableName: tableInfo.tableName,
        templateName: template.name,
        reason: sql.slice(3).trim() || '当前任务缺少可执行字段。',
        message: '当前任务未提交到服务端，请重新生成批量任务队列后再执行。',
        durationMs: performance.now() - startedAt
      });
      return;
    }

    const controller = new AbortController();
    state.batchAbortControllers.add(controller);

    try {
      const payload = await api('/api/query', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          database: state.currentDatabase,
          table: tableInfo.tableName,
          tableComment: tableInfo.tableComment || '',
          sql,
          capture: true,
          taskName: job.folderName,
          imageName: template.name,
          templateId: job.templateId,
          captureProfileKey: `batch-worker-${workerId}`,
          captureOptions: {
            hideSql: job.templateId === 'table-structure',
            showTableMeta: job.templateId === 'table-structure'
          }
        })
      });

      if (payload.artifact) {
        appendRunEntry({
          kind: 'success',
          title: taskTitle,
          tableName: tableInfo.tableName,
          templateName: template.name,
          imagePath: payload.artifact.imagePath,
          durationMs: performance.now() - startedAt
        });
      }
    } catch (error) {
      if (controller.signal.aborted && state.batchCancelRequested) {
        state.batchCancelledCount += 1;
        appendRunEntry({
          kind: 'error',
          title: taskTitle,
          tableName: tableInfo.tableName,
          templateName: template.name,
          reason: '用户提前结束批量任务，客户端已停止等待该任务。',
          message: '已经提交到数据库或浏览器的任务可能仍会继续完成，已生成的图片和日志会保留在本地。',
          durationMs: performance.now() - startedAt
        });
      } else {
        state.batchFailures += 1;
        const details = describeApiError(error);
        appendRunEntry({
          kind: 'error',
          title: taskTitle,
          tableName: tableInfo.tableName,
          templateName: template.name,
          reason: details.reason,
          logPath: details.logPath,
          message: details.message,
          durationMs: performance.now() - startedAt
        });
        console.warn(error);
      }
    } finally {
      state.batchAbortControllers.delete(controller);
      state.batchCompleted += 1;
      elements.batchProgressFill.style.width = `${(state.batchCompleted / tasks.length) * 100}%`;
      updateBatchProgressUi(
        state.batchCancelRequested
          ? `${state.batchCompleted} / ${tasks.length} · 正在提前结束`
          : state.batchFailures
            ? `${state.batchCompleted} / ${tasks.length} · 已出现 ${state.batchFailures} 个失败项`
            : `${state.batchCompleted} / ${tasks.length} · 执行中`
      );
    }
  };

  const runWorker = async (workerId) => {
    while (nextIndex < tasks.length && !state.batchCancelRequested) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await executeSingleTask(tasks[currentIndex], workerId);
    }
  };

  await Promise.all(
    Array.from({ length: concurrency }, (_, workerId) => runWorker(workerId))
  );

  if (state.batchCancelRequested) {
    state.batchCancelledCount += Math.max(0, tasks.length - nextIndex);
  }

  state.batchRunning = false;
  const finalCompleted = state.batchCompleted;
  const finalFailures = state.batchFailures;
  const finalCancelled = state.batchCancelledCount;
  const wasCancelled = state.batchCancelRequested;
  const totalDurationMs = performance.now() - state.batchStartedAt;
  finalizeRun();
  updateBatchProgressUi(
    wasCancelled
      ? `已提前结束 · 已完成 ${finalCompleted}/${tasks.length}，取消 ${finalCancelled} 个，总耗时 ${formatDuration(totalDurationMs)}`
      : finalFailures
        ? `执行结束 · ${finalCompleted}/${tasks.length}，失败 ${finalFailures} 个，总耗时 ${formatDuration(totalDurationMs)}`
        : `执行结束 · ${finalCompleted}/${tasks.length} 全部成功，总耗时 ${formatDuration(totalDurationMs)}`
  );
  syncBatchActionButtons();
  closeBatchModal(true);
  renderWorkflowSummary();
  updateStepStates();
  setStatus(
    wasCancelled
      ? `批量任务已提前结束。已完成 ${finalCompleted} 个，取消 ${finalCancelled} 个，总耗时 ${formatDuration(totalDurationMs)}。`
      : finalFailures
        ? `批量截图完成，但有 ${finalFailures} 个失败项，批量耗时 ${formatDuration(totalDurationMs)}。`
        : `批量截图完成，共生成 ${finalCompleted} 张截图，批量耗时 ${formatDuration(totalDurationMs)}。`,
    wasCancelled || finalFailures ? 'error' : 'success'
  );
}

function renderQueryTemplates() {
  const wrapper = document.createElement('div');
  wrapper.className = 'sql-template-list';
  QUERY_TEMPLATES.forEach((template) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sql-template-option${template.id === state.currentTemplateId ? ' is-active' : ''}`;
    const title = document.createElement('strong');
    title.textContent = template.name;
    const desc = document.createElement('span');
    desc.textContent = template.description;
    button.append(title, desc);
    button.addEventListener('click', () => {
      state.currentTemplateId = template.id;
      updateSqlPreview();
      renderQueryTemplates();
      setStatus(`已切换到模板：${template.name}`);
    });
    wrapper.appendChild(button);
  });
  elements.sqlTemplateList.replaceChildren(wrapper);
}

function renderTasks() {
  if (!state.tasks.length) {
    elements.taskCountLabel.textContent = '0 张表';
    elements.tasksPane.className = 'task-list empty-state';
    elements.tasksPane.textContent = '还没有生成具体批量任务。';
    return;
  }

  const groups = new Map();
  state.tasks.forEach((task) => {
    if (!groups.has(task.tableName)) {
      groups.set(task.tableName, []);
    }
    groups.get(task.tableName).push(task);
  });

  elements.taskCountLabel.textContent = `${groups.size} 张表 · ${state.tasks.length} 个任务`;
  const wrapper = document.createElement('div');
  wrapper.className = 'task-group-list';

  [...groups.entries()].forEach(([tableName, tasks]) => {
    const tableInfo = getTableInfo(tableName) || { tableName, tableComment: '' };
    const enabledCount = tasks.filter((task) => task.enabled).length;
    const unsupportedCount = tasks.filter((task) => !isTemplateSupported(tableInfo, task.templateId)).length;
    const details = document.createElement('details');
    details.className = 'task-group-card';

    const summary = document.createElement('summary');
    summary.className = 'task-group-summary';

    const summaryMain = document.createElement('div');
    summaryMain.className = 'task-group-main';
    const title = document.createElement('strong');
    title.textContent = tableInfo.tableName;
    const subtitle = document.createElement('p');
    subtitle.className = 'task-group-subtitle';
    subtitle.textContent = tableInfo.tableComment || '未填写表注释';
    summaryMain.append(title, subtitle);

    const summaryMeta = document.createElement('div');
    summaryMeta.className = 'task-group-meta';
    const countBadge = document.createElement('span');
    countBadge.className = 'badge badge-muted';
    countBadge.textContent = `${enabledCount}/${tasks.length} 已启用`;
    summaryMeta.appendChild(countBadge);
    if (unsupportedCount) {
      const warningBadge = document.createElement('span');
      warningBadge.className = 'badge badge-outline';
      warningBadge.textContent = `${unsupportedCount} 个待处理`;
      summaryMeta.appendChild(warningBadge);
    }

    summary.append(summaryMain, summaryMeta);

    const body = document.createElement('div');
    body.className = 'task-group-body';
    const hint = document.createElement('p');
    hint.className = 'task-group-hint';
    hint.textContent = unsupportedCount
      ? `共 ${tasks.length} 个任务，其中 ${unsupportedCount} 个模板当前缺少字段或需要重新生成。`
      : `共 ${tasks.length} 个任务，按当前表的可用模板整理。`;
    body.appendChild(hint);

    tasks
      .slice()
      .sort((left, right) => {
        const templateOrder = QUERY_TEMPLATES.findIndex((item) => item.id === left.templateId) - QUERY_TEMPLATES.findIndex((item) => item.id === right.templateId);
        return templateOrder || left.folderName.localeCompare(right.folderName, 'zh-CN');
      })
      .forEach((task) => {
        const template = getTemplateById(task.templateId);
        const supported = isTemplateSupported(tableInfo, task.templateId);
        const supportReason = supported ? '' : getTemplateSkipReason(tableInfo, task.templateId);
        const row = document.createElement('article');
        row.className = `task-row${task.enabled ? '' : ' is-disabled'}${supported ? '' : ' is-warning'}`;

        const rowHead = document.createElement('div');
        rowHead.className = 'task-row-head';

        const headLeft = document.createElement('div');
        headLeft.className = 'task-row-main';
        const toggleWrap = document.createElement('label');
        toggleWrap.className = 'task-row-toggle';
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = task.enabled;
        toggle.addEventListener('change', () => {
          task.enabled = toggle.checked;
          saveTasks();
          renderTasks();
          updateStepStates();
        });
        const toggleText = document.createElement('span');
        toggleText.textContent = `${task.folderName} · ${template.name}`;
        toggleWrap.append(toggle, toggleText);
        const info = document.createElement('p');
        info.className = 'task-row-note';
        info.textContent = supported
          ? `预计输出目录：${task.folderName}/${tableInfo.tableName}/${template.name}.png`
          : `当前不可执行：${supportReason}`;
        headLeft.append(toggleWrap, info);

        const rowMeta = document.createElement('div');
        rowMeta.className = 'task-row-meta';
        const stateBadge = document.createElement('span');
        stateBadge.className = supported ? 'badge badge-muted' : 'badge badge-outline';
        stateBadge.textContent = supported ? '可执行' : '字段待补';
        rowMeta.appendChild(stateBadge);

        rowHead.append(headLeft, rowMeta);

        const sql = document.createElement('pre');
        sql.className = 'task-sql';
        sql.textContent = supported
          ? buildTemplateSql(task.templateId, state.currentDatabase, tableInfo.tableName || '', tableInfo.tableComment || '')
          : `-- ${supportReason}`;
        const fieldSummary = getTemplateFieldSummary(task.templateId, tableInfo.tableName);
        const sqlMeta = document.createElement('p');
        sqlMeta.className = 'task-row-field-note';
        sqlMeta.textContent = fieldSummary;
        sqlMeta.hidden = !fieldSummary;

        const actions = document.createElement('div');
        actions.className = 'action-row compact';
        const loadButton = document.createElement('button');
        loadButton.type = 'button';
        loadButton.className = 'button button-secondary';
        loadButton.textContent = '载入';
        loadButton.addEventListener('click', async () => {
          state.currentTemplateId = task.templateId;
          elements.taskNameInput.value = task.folderName;
          elements.tableSelect.value = task.tableName;
          await selectTable(task.tableName);
          updateSqlPreview();
          renderQueryTemplates();
          setStatus(`已载入任务 "${formatTaskTitle(task, tableInfo, template)}"。`);
        });
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'button button-ghost';
        deleteButton.textContent = '删除';
        deleteButton.addEventListener('click', () => {
          state.tasks = state.tasks.filter((item) => item.id !== task.id);
          saveTasks();
          renderTasks();
          updateStepStates();
          setStatus(`已删除任务 "${formatTaskTitle(task, tableInfo, template)}"。`);
        });
        const runButton = document.createElement('button');
        runButton.type = 'button';
        runButton.className = 'button button-primary';
        runButton.textContent = '执行此任务';
        runButton.disabled = !supported;
        if (!supported) {
          runButton.title = supportReason;
        }
        runButton.addEventListener('click', () => {
          if (!supported) {
            setStatus(supportReason, 'error');
            return;
          }
          state.batchTasksOverride = [task];
          openBatchModal();
        });
        actions.append(loadButton, deleteButton, runButton);
        row.append(rowHead, sql, sqlMeta, actions);
        body.appendChild(row);
      });

    details.append(summary, body);
    wrapper.appendChild(details);
  });

  elements.tasksPane.className = '';
  elements.tasksPane.replaceChildren(wrapper);
  renderWorkflowSummary();
}

function describeApiError(error) {
  const payload = error?.payload || {};
  return {
    message: payload.message || error.message || '任务执行失败。',
    reason: payload.reason || '',
    logPath: payload.logPath || ''
  };
}

function beginRun({ folderName, kind }) {
  state.runContext = {
    folderName: String(folderName || '').trim(),
    kind: kind === 'batch' ? 'batch' : 'single',
    startedAt: performance.now(),
    finished: false
  };
  state.runEntries = [];
  state.runStats = {
    success: 0,
    warning: 0,
    failure: 0,
    total: 0,
    durationMs: 0,
    tables: new Set()
  };
  renderRunSummary();
  updateStepStates();
}

function appendRunEntry(entry) {
  if (!state.runContext) {
    beginRun({ folderName: entry.folderName || '', kind: entry.runKind || 'single' });
  }
  const normalized = {
    kind: entry.kind || 'success',
    title: entry.title || '',
    tableName: entry.tableName || '',
    templateName: entry.templateName || '',
    imagePath: entry.imagePath || '',
    reason: entry.reason || '',
    logPath: entry.logPath || '',
    message: entry.message || '',
    durationMs: entry.durationMs || 0,
    timestamp: Date.now()
  };
  state.runEntries.push(normalized);
  if (normalized.kind === 'success') state.runStats.success += 1;
  else if (normalized.kind === 'warning') state.runStats.warning += 1;
  else state.runStats.failure += 1;
  state.runStats.total = state.runEntries.length;
  if (normalized.tableName) state.runStats.tables.add(normalized.tableName);
  renderRunSummary();
  updateStepStates();
}

function finalizeRun() {
  if (!state.runContext) return;
  state.runContext.finished = true;
  state.runStats.durationMs = performance.now() - state.runContext.startedAt;
  renderRunSummary();
}

async function openRunFolder() {
  if (!state.runContext?.folderName) return;
  try {
    await api('/api/open-folder', {
      method: 'POST',
      body: JSON.stringify({ path: `captures/${state.runContext.folderName}` })
    });
  } catch (error) {
    const details = describeApiError(error);
    setStatus(`打开目录失败：${details.reason || details.message}`, 'error');
  }
}

function renderRunSummary() {
  const summary = elements.runSummaryPane;
  const details = elements.runDetailsPane;
  const badge = elements.runFolderBadge;
  if (!summary || !details) return;

  if (!state.runContext) {
    summary.className = 'run-summary-empty';
    summary.textContent = '执行并截图后，这里会显示汇总统计和本次输出目录入口。';
    details.className = 'run-details is-hidden';
    details.replaceChildren();
    if (badge) {
      badge.classList.add('is-hidden');
      badge.textContent = '';
    }
    return;
  }

  const { folderName, kind, finished } = state.runContext;
  const { success, warning, failure, total, tables, durationMs } = state.runStats;
  const kindText = kind === 'batch' ? '批量运行' : '单表运行';

  if (badge) {
    if (folderName) {
      badge.classList.remove('is-hidden');
      badge.textContent = folderName;
    } else {
      badge.classList.add('is-hidden');
      badge.textContent = '';
    }
  }

  summary.className = 'run-summary';
  summary.replaceChildren();

  const headline = document.createElement('p');
  headline.className = 'run-summary-headline';
  const timingText = finished
    ? `耗时 ${formatDuration(durationMs)}`
    : '执行中...';
  headline.textContent = `${kindText} · ${tables.size} 张表 · ${total} 条记录 · ${timingText}`;
  summary.appendChild(headline);

  const tiles = document.createElement('div');
  tiles.className = 'run-tiles';
  tiles.append(
    buildRunTile('success', success, '成功'),
    buildRunTile('warning', warning, '告警'),
    buildRunTile('failure', failure, '失败')
  );
  summary.appendChild(tiles);

  const actions = document.createElement('div');
  actions.className = 'run-actions';
  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'button button-secondary run-open-folder';
  openButton.textContent = folderName ? `📂 打开本次任务目录（${folderName}）` : '📂 打开本次任务目录';
  openButton.disabled = !folderName;
  openButton.addEventListener('click', openRunFolder);
  actions.appendChild(openButton);

  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.className = 'button button-ghost run-clear';
  clearButton.textContent = '清空记录';
  clearButton.addEventListener('click', () => {
    state.runContext = null;
    state.runEntries = [];
    state.runStats = { success: 0, warning: 0, failure: 0, total: 0, durationMs: 0, tables: new Set() };
    renderRunSummary();
    updateStepStates();
  });
  actions.appendChild(clearButton);
  summary.appendChild(actions);

  const failureEntries = state.runEntries.filter((entry) => entry.kind === 'error');
  const warningEntries = state.runEntries.filter((entry) => entry.kind === 'warning');
  const successEntries = state.runEntries.filter((entry) => entry.kind === 'success');

  details.replaceChildren();
  if (!total) {
    details.className = 'run-details is-hidden';
    return;
  }

  details.className = 'run-details';
  if (failureEntries.length) {
    details.appendChild(buildRunDetailsGroup('failure', '失败明细', failureEntries, true));
  }
  if (warningEntries.length) {
    details.appendChild(buildRunDetailsGroup('warning', '告警明细', warningEntries, true));
  }
  if (successEntries.length) {
    details.appendChild(buildRunDetailsGroup('success', '成功任务', successEntries, false));
  }
}

function buildRunTile(tone, value, label) {
  const tile = document.createElement('div');
  tile.className = `run-tile run-tile-${tone}${value > 0 ? ' is-active' : ''}`;
  const number = document.createElement('strong');
  number.textContent = String(value);
  const text = document.createElement('span');
  text.textContent = label;
  tile.append(number, text);
  return tile;
}

function buildRunDetailsGroup(tone, label, entries, defaultOpen) {
  const group = document.createElement('details');
  group.className = `run-details-group run-details-group-${tone}`;
  if (defaultOpen) group.open = true;
  const summaryEl = document.createElement('summary');
  summaryEl.textContent = `${label}（${entries.length}）`;
  group.appendChild(summaryEl);

  const list = document.createElement('ul');
  list.className = 'run-entry-list';
  entries.forEach((entry) => {
    const item = document.createElement('li');
    item.className = `run-entry run-entry-${tone}`;
    const top = document.createElement('div');
    top.className = 'run-entry-head';
    const title = document.createElement('span');
    title.className = 'run-entry-title';
    title.textContent = entry.title || entry.tableName;
    top.appendChild(title);
    if (entry.durationMs) {
      const duration = document.createElement('span');
      duration.className = 'run-entry-duration';
      duration.textContent = formatDuration(entry.durationMs);
      top.appendChild(duration);
    }
    item.appendChild(top);

    if (entry.kind === 'success' && entry.imagePath) {
      const pathRow = document.createElement('p');
      pathRow.className = 'run-entry-meta';
      pathRow.textContent = entry.imagePath;
      item.appendChild(pathRow);
    }
    if (entry.reason) {
      const reason = document.createElement('p');
      reason.className = 'run-entry-reason';
      reason.textContent = entry.reason;
      item.appendChild(reason);
    }
    if (entry.message && entry.message !== entry.reason) {
      const detail = document.createElement('p');
      detail.className = 'run-entry-detail';
      detail.textContent = entry.message;
      item.appendChild(detail);
    }
    if (entry.logPath) {
      const logRow = document.createElement('p');
      logRow.className = 'run-entry-meta';
      logRow.textContent = `日志：${entry.logPath}`;
      item.appendChild(logRow);
    }
    list.appendChild(item);
  });

  group.appendChild(list);
  return group;
}
async function refreshStatus() {
  const payload = await retryRequest(() => api('/api/status', { method: 'GET' }), 3, 300);
  setBrowserStatus(payload.browser);
  if (!payload.connected) {
    window.location.replace('/');
    return false;
  }
  state.connection = payload.connection;
  setConnectionBadge(true);
  setConnectionMeta(payload.connection);
  updateStepStates();
  return true;
}

async function loadDatabases() {
  const payload = await retryRequest(() => api('/api/databases', { method: 'GET' }), 2, 300);
  state.databases = payload.databases;
  renderDatabaseOptions();
  if (state.databases.length) {
    state.currentDatabase = state.databases[0];
    elements.databaseSelect.value = state.currentDatabase;
    await loadTables();
  }
}

function resetQueryViews() {
  state.columns = [];
  state.preview = { columns: [], rows: [] };
  state.result = { columns: [], rows: [] };
  renderColumns();
  renderPreview();
  renderResult();
}

async function loadTables() {
  const database = elements.databaseSelect.value;
  const previousDatabase = state.currentDatabase;
  if (state.batchRunning && database !== previousDatabase) {
    elements.databaseSelect.value = previousDatabase;
    setStatus('批量执行中，暂不支持切换数据库。', 'error');
    return;
  }
  if (!database) {
    if (previousDatabase && previousDatabase !== database) {
      clearTaskQueue({ silent: true, source: 'database-switch' });
    }
    state.currentDatabase = '';
    state.currentTable = '';
    state.tables = [];
    state.selectedTables.clear();
    renderTableSelects();
    updateCurrentTableLabel();
    resetQueryViews();
    updateStepStates();
    updateSqlPreview();
    return;
  }
  const switchingDatabase = Boolean(previousDatabase) && previousDatabase !== database;
  const clearedTasks = switchingDatabase
    ? clearTaskQueue({ silent: true, source: 'database-switch' })
    : 0;
  state.currentDatabase = database;
  state.currentTable = '';
  state.selectedTables.clear();
  updateCurrentTableLabel();
  resetQueryViews();
  setStatus(`正在读取 ${database} 的库表列表...`, 'working');
  if (clearedTasks) {
    setStatus(`已切换到 ${database}，并清空上一数据库的 ${clearedTasks} 个任务，正在读取库表列表...`, 'working');
  }
  const payload = await retryRequest(
    () => api(`/api/tables?database=${encodeURIComponent(database)}`, { method: 'GET' }),
    2,
    300
  );
  state.tables = payload.tables;
  renderTableSelects();
  updateStepStates();
  updateSqlPreview();
  setStatus(`已载入 ${database} 的 ${state.tables.length} 张表。`, 'success');
}

async function selectTable(tableName) {
  if (!tableName) {
    state.currentTable = '';
    updateCurrentTableLabel();
    resetQueryViews();
    updateStepStates();
    updateSqlPreview();
    return;
  }
  state.currentTable = tableName;
  updateCurrentTableLabel();
  updateSqlPreview();
  setStatus(`正在读取 ${tableName} 的结构和预览数据...`, 'working');
  try {
    const [columnsPayload, previewPayload] = await Promise.all([
      api(`/api/columns?database=${encodeURIComponent(state.currentDatabase)}&table=${encodeURIComponent(tableName)}`, { method: 'GET' }),
      api(`/api/preview?database=${encodeURIComponent(state.currentDatabase)}&table=${encodeURIComponent(tableName)}&limit=${encodeURIComponent(elements.previewLimitInput.value)}`, { method: 'GET' })
    ]);
    state.columns = columnsPayload.columns;
    state.preview = previewPayload.result;
    renderColumns();
    renderPreview();
    renderTasks();
    updateStepStates();
    setStatus(`已加载 ${tableName} 的字段结构和预览数据。`, 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function runQuery(capture) {
  const tableInfo = getTableInfo();
  const template = getTemplateById(state.currentTemplateId);
  if (!state.currentDatabase || !tableInfo) {
    setStatus('请先选择数据库和表。', 'error');
    return;
  }
  const sql = buildTemplateSql(state.currentTemplateId, state.currentDatabase, tableInfo.tableName, tableInfo.tableComment || '');
  if (sql.startsWith('--')) {
    setStatus(sql.slice(3).trim() || '当前模板缺少可用字段，无法执行。', 'error');
    return;
  }
  updateSqlPreview();
  setStatus(capture ? '正在执行查询并生成截图...' : '正在执行查询...', 'working');
  const startedAt = performance.now();
  const singleRunFolderName = elements.taskNameInput.value.trim() || '单表试跑';
  if (capture) {
    beginRun({ folderName: singleRunFolderName, kind: 'single' });
  }
  try {
    if (state.currentTemplateId === 'storage-usage') {
      setStatus('正在刷新统计信息以确保存储空间为最新值...', 'working');
      try {
        await api('/api/analyze-table', {
          method: 'POST',
          body: JSON.stringify({
            database: state.currentDatabase,
            table: tableInfo.tableName
          })
        });
      } catch (analyzeError) {
        const details = describeApiError(analyzeError);
        const fallbackDetail = details.message && details.message !== details.reason
          ? `${details.message} 查询存储空间仍会继续执行，但返回结果可能基于旧统计值。`
          : '查询存储空间仍会继续执行，但返回结果可能基于旧统计值。';
        if (capture) {
          appendRunEntry({
            kind: 'warning',
            title: `统计信息刷新 / ${tableInfo.tableName}`,
            tableName: tableInfo.tableName,
            templateName: 'ANALYZE TABLE',
            reason: details.reason || details.message || '刷新统计信息失败。',
            logPath: details.logPath,
            message: fallbackDetail
          });
        }
        console.warn('analyze-table failed (single-run)', tableInfo.tableName, analyzeError);
      }
      setStatus(capture ? '正在执行查询并生成截图...' : '正在执行查询...', 'working');
    }
    const payload = await api('/api/query', {
      method: 'POST',
      body: JSON.stringify({
        database: state.currentDatabase,
        table: tableInfo.tableName,
        tableComment: tableInfo.tableComment || '',
        sql,
        capture,
        taskName: singleRunFolderName,
        imageName: template.name,
        templateId: state.currentTemplateId,
        captureProfileKey: capture ? 'single-run-preview' : '',
        captureOptions: {
          hideSql: state.currentTemplateId === 'table-structure',
          showTableMeta: state.currentTemplateId === 'table-structure'
        }
      })
    });
    state.result = payload.result;
    renderResult();
    updateStepStates();
    if (payload.artifact) {
      appendRunEntry({
        kind: 'success',
        title: `${singleRunFolderName} / ${tableInfo.tableName} / ${template.name}`,
        tableName: tableInfo.tableName,
        templateName: template.name,
        imagePath: payload.artifact.imagePath,
        durationMs: performance.now() - startedAt
      });
    }
    setStatus(capture ? `查询完成，已保存截图到 ${payload.artifact.imagePath}` : `查询完成，返回 ${payload.result.rows.length} 行。`, 'success');
  } catch (error) {
    if (capture) {
      const details = describeApiError(error);
      appendRunEntry({
        kind: 'error',
        title: `${singleRunFolderName} / ${tableInfo.tableName} / ${template.name}`,
        tableName: tableInfo.tableName,
        templateName: template.name,
        reason: details.reason,
        logPath: details.logPath,
        message: details.message,
        durationMs: performance.now() - startedAt
      });
    }
    setStatus(error.message, 'error');
  } finally {
    if (capture) {
      finalizeRun();
    }
  }
}

function saveCurrentTask() {
  const folderName = elements.taskNameInput.value.trim();
  if (!folderName) {
    setStatus('请先填写任务模板文件夹名。', 'error');
    return;
  }
  const selectedTables = getSelectedTableInfos();
  if (!selectedTables.length) {
    setStatus('请先在第一步勾选至少一张目标表。', 'error');
    return;
  }

  let createdCount = 0;
  let reusedCount = 0;
  let skippedCount = 0;
  const skippedIssues = [];

  selectedTables.forEach((tableInfo) => {
    QUERY_TEMPLATES.forEach((template) => {
      if (!isTemplateSupported(tableInfo, template.id)) {
        skippedCount += 1;
        skippedIssues.push({
          tableName: tableInfo.tableName,
          templateName: template.name,
          reason: getTemplateSkipReason(tableInfo, template.id)
        });
        return;
      }

      const existing = state.tasks.find(
        (task) => task.folderName === folderName && task.tableName === tableInfo.tableName && task.templateId === template.id
      );

      if (existing) {
        existing.enabled = true;
        reusedCount += 1;
        return;
      }

      state.tasks.unshift({
        id: crypto.randomUUID(),
        folderName,
        tableName: tableInfo.tableName,
        templateId: template.id,
        enabled: true
      });
      createdCount += 1;
    });
  });

  saveTasks();
  renderTasks();
  updateStepStates();
  const messages = [];
  if (createdCount) messages.push(`已生成 ${createdCount} 个新任务`);
  if (reusedCount) messages.push(`另有 ${reusedCount} 个已存在任务已重新启用`);
  if (skippedCount) messages.push(`有 ${skippedCount} 个模板因字段缺失未加入队列`);
  setStatus(messages.length ? `${messages.join('，')}。` : '当前没有新增任务。', skippedCount && !createdCount && !reusedCount ? 'error' : 'success');
  if (skippedIssues.length) {
    const details = skippedIssues
      .slice(0, 20)
      .map((issue) => `表 ${issue.tableName} / ${issue.templateName}: ${issue.reason}`)
      .join('\n');
    window.alert(`以下 ${skippedIssues.length} 个模板未加入批量任务：\n${details}${skippedIssues.length > 20 ? '\n……其余条目请逐表检查。' : ''}`);
  }
  if (createdCount || reusedCount) {
    const enabledCount = state.tasks.filter((task) => task.enabled).length;
    prewarmCaptureSessions(enabledCount).catch((error) => console.warn('capture prewarm failed', error));
  }
}

async function prewarmCaptureSessions(taskCount = 0) {
  const workerCount = getBatchConcurrency(taskCount);
  const keys = ['single-run-preview'];
  for (let i = 0; i < workerCount; i++) {
    keys.push(`batch-worker-${i}`);
  }
  await api('/api/capture/warmup', {
    method: 'POST',
    body: JSON.stringify({ keys })
  });
}

function hydrateDrafts() {
  const savedTemplateId = localStorage.getItem(STORAGE_KEYS.templateId);
  try {
    state.fieldOverrides = JSON.parse(localStorage.getItem(STORAGE_KEYS.fieldOverrides) || '{}') || {};
  } catch {
    state.fieldOverrides = {};
  }
  state.currentTemplateId = QUERY_TEMPLATES.some((item) => item.id === savedTemplateId) ? savedTemplateId : QUERY_TEMPLATES[0].id;
  updateSqlPreview();
}

function bindEvents() {
  elements.refreshTablesButton.addEventListener('click', () => loadTables().catch((error) => setStatus(error.message, 'error')));
  elements.databaseSelect.addEventListener('change', () => loadTables().catch((error) => setStatus(error.message, 'error')));
  elements.tableSelect.addEventListener('change', () => selectTable(elements.tableSelect.value));
  elements.previewLimitInput.addEventListener('change', () => { if (state.currentTable) selectTable(state.currentTable); });
  elements.selectAllTablesButton.addEventListener('click', () => { state.selectedTables = new Set(state.tables.map((table) => table.tableName)); renderTaskTableChecklist(); updateStepStates(); setStatus(`已勾选 ${state.selectedTables.size} 张任务表。`); });
  elements.clearSelectedTablesButton.addEventListener('click', () => { state.selectedTables.clear(); renderTaskTableChecklist(); updateStepStates(); setStatus('已清空任务作用表。'); });
  if (elements.clearTasksButton) {
    elements.clearTasksButton.addEventListener('click', () => clearTaskQueue());
  }
  elements.runQueryButton.addEventListener('click', () => runQuery(false));
  elements.runAndCaptureButton.addEventListener('click', () => runQuery(true));
  elements.saveTaskButton.addEventListener('click', saveCurrentTask);
  if (elements.copySelectedSqlButton) {
    elements.copySelectedSqlButton.addEventListener('click', () => {
      copySelectedTablesSqlScript().catch((error) => setStatus(error.message, 'error'));
    });
  }
  if (elements.copySelectedSqlButtonNoStructure) {
    elements.copySelectedSqlButtonNoStructure.addEventListener('click', () => {
      copySelectedTablesSqlScript({
        excludeTemplateIds: ['table-structure'],
        label: '不含表结构查询'
      }).catch((error) => setStatus(error.message, 'error'));
    });
  }
  elements.runTasksButton.addEventListener('click', openBatchModal);
  elements.batchModalCloseButton.addEventListener('click', () => closeBatchModal());
  elements.batchModalCancelButton.addEventListener('click', () => closeBatchModal());
  elements.batchModalConfirmButton.addEventListener('click', () => executeBatchRun());
  if (elements.batchModalStopButton) {
    elements.batchModalStopButton.addEventListener('click', () => requestBatchCancellation());
  }
  if (elements.batchProgressDockToggle) {
    elements.batchProgressDockToggle.addEventListener('click', () => expandBatchModal());
  }
  if (elements.batchProgressDockStopButton) {
    elements.batchProgressDockStopButton.addEventListener('click', () => requestBatchCancellation());
  }
  window.addEventListener('beforeunload', (event) => {
    if (!hasResettablePageState()) {
      return;
    }
    event.preventDefault();
    event.returnValue = '';
  });
  document.querySelectorAll('.progress-item[data-target]').forEach((item) => {
    item.addEventListener('click', () => {
      const targetId = item.dataset.target;
      const target = document.getElementById(targetId);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

function reveal() {
  document.querySelectorAll('.reveal').forEach((node, index) => {
    node.style.animationDelay = `${index * 90}ms`;
  });
}

function applyRuntimeCopy() {
  const workspaceSubtitle = document.querySelector('.workspace-subtitle');

  if (workspaceSubtitle) {
    workspaceSubtitle.textContent = '模板查询·字段识别·抽检预览·批量截图·结果留档';
  }
}

function initPreviewMode() {
  state.connection = { host: '127.0.0.1', port: '3306', user: 'preview' };
  state.databases = ['preview_workspace'];
  state.currentDatabase = state.databases[0];
  state.currentTable = 'scjy_zhyq_daily_operation';
  state.currentTemplateId = 'table-structure';
  state.tables = [
    {
      tableName: 'scjy_zhyq_daily_operation',
      tableComment: '园区日常运营',
      detectedFields: { timeField: 'record_time', regionField: 'region_name' }
    },
    {
      tableName: 'scjy_qyyd_electricity_detail',
      tableComment: '企业用电明细',
      detectedFields: { timeField: 'record_time', regionField: 'area_name' }
    },
    {
      tableName: 'scjy_tcsf_parking_fee',
      tableComment: '停车收费记录',
      detectedFields: { timeField: 'pay_time', regionField: 'zone_name' }
    }
  ];
  state.selectedTables = new Set(state.tables.map((table) => table.tableName));
  state.columns = [
    { ordinalPosition: 1, columnName: 'id', columnType: 'bigint', isNullable: 'NO', columnDefault: null, columnComment: '主键' },
    { ordinalPosition: 2, columnName: 'record_time', columnType: 'datetime', isNullable: 'NO', columnDefault: null, columnComment: '记录时间' },
    { ordinalPosition: 3, columnName: 'region_name', columnType: 'varchar(64)', isNullable: 'YES', columnDefault: null, columnComment: '区域名称' },
    { ordinalPosition: 4, columnName: 'device_total', columnType: 'int', isNullable: 'YES', columnDefault: '0', columnComment: '设备总数' },
    { ordinalPosition: 5, columnName: 'online_total', columnType: 'int', isNullable: 'YES', columnDefault: '0', columnComment: '在线设备数' }
  ];
  state.preview = {
    columns: ['record_time', 'region_name', 'device_total', 'online_total'],
    rows: [
      { record_time: '2026-04-12 08:00:00', region_name: 'A区', device_total: 42, online_total: 39 },
      { record_time: '2026-04-12 08:00:00', region_name: 'B区', device_total: 37, online_total: 34 },
      { record_time: '2026-04-12 08:00:00', region_name: 'C区', device_total: 51, online_total: 48 }
    ]
  };
  state.result = {
    columns: ['序号', '字段名', '类型', '可空', '默认值', '注释'],
    rows: [
      { 序号: 1, 字段名: 'id', 类型: 'bigint', 可空: '否', 默认值: 'NULL', 注释: '主键' },
      { 序号: 2, 字段名: 'record_time', 类型: 'datetime', 可空: '否', 默认值: 'NULL', 注释: '记录时间' },
      { 序号: 3, 字段名: 'region_name', 类型: 'varchar(64)', 可空: '是', 默认值: 'NULL', 注释: '区域名称' }
    ]
  };
  state.tasks = [
    { id: 'preview-1', folderName: '示例归档', tableName: 'scjy_zhyq_daily_operation', templateId: 'table-structure', enabled: true },
    { id: 'preview-2', folderName: '示例归档', tableName: 'scjy_qyyd_electricity_detail', templateId: 'time-range', enabled: true },
    { id: 'preview-3', folderName: '示例归档', tableName: 'scjy_tcsf_parking_fee', templateId: 'total-rows', enabled: true }
  ];

  renderDatabaseOptions();
  renderTableSelects();
  updateCurrentTableLabel();
  updateSqlPreview();
  renderColumns();
  renderPreview();
  renderResult();
  renderTasks();
  renderQueryTemplates();
  setConnectionBadge(true);
  setConnectionMeta(state.connection);
  setBrowserStatus('available');
  if (elements.optionalPreviewDisclosure) {
    elements.optionalPreviewDisclosure.open = true;
  }
  elements.previewDisclosure.open = true;
  elements.taskNameInput.value = '示例归档';
  beginRun({ folderName: '示例归档', kind: 'batch' });
  appendRunEntry({
    kind: 'success',
    title: '示例归档 / scjy_zhyq_daily_operation / 查询表结构',
    tableName: 'scjy_zhyq_daily_operation',
    templateName: '查询表结构',
    imagePath: 'captures/demo/scjy_zhyq_daily_operation/查询表结构.png',
    durationMs: 1860
  });
  finalizeRun();
  updateStepStates();
  elements.statusBar.textContent = '预览模式：当前展示的是示例数据界面，不会访问数据库。';
  elements.statusBar.dataset.type = 'success';
  if (elements.toastMessage) {
    elements.toastMessage.classList.remove('is-visible');
  }
}

async function init() {
  state.tasks = loadTasks();
  hydrateDrafts();
  applyRuntimeCopy();
  updateCurrentTableLabel();
  renderColumns();
  renderPreview();
  renderResult();
  renderTasks();
  renderQueryTemplates();
  bindEvents();
  reveal();
  syncBatchActionButtons();
  syncBatchProgressDock();
  updateStepStates();
  if (PREVIEW_MODE) {
    initPreviewMode();
    return;
  }
  try {
    const ready = await refreshStatus();
    if (!ready) return;
    await loadDatabases();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

init();

