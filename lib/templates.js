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
  'region', 'region_name', 'area', 'area_name', 'district', 'zone',
  'province', 'province_name', 'city', 'city_name', 'county', 'county_name',
  'town', 'town_name', 'township', 'street', 'village', 'community',
  'location_town', 'location_county', 'location_city', 'location_area', 'location_region'
];
const REGION_FIELD_NAME_PATTERN = /(^|_)(region|area|district|zone|province|city|county|town|township|street|village|community)(_|$)/;
const REGION_FIELD_COMMENT_PATTERN = /(区域|地区|省|市|县|区|镇|乡|街道|村|社区)/;
const REGION_FIELD_EXCLUDE_PATTERN = /(^|_)(id|hash|md5|sha1|sha256|uuid|guid|token|salt|pwd|password|create|created|update|updated|delete|deleted|time|date)(_|$)/;

const CAPTURE_FILE_NAME_BY_TEMPLATE_ID = {
  'time-range': '记录时间',
  'storage-usage': '表空间',
  'total-rows': '表行数',
  'region-distribution': '区域数据',
  'table-structure': '表结构'
};

const MAX_IDENTIFIER_LENGTH = 64;
const REGION_RESULT_LIMIT = 500;
const REGION_VALUE_CHARACTER_LIMIT = 512;
const UNSAFE_TEMPLATE_FIELD_TYPE_PATTERN = /(?:blob|binary|varbinary|json|bit|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|vector)/iu;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.expose = true;
  return error;
}

function normalizeIdentifier(value, label) {
  const identifier = String(value || '').trim();
  if (!identifier) {
    throw badRequest(`${label}不能为空。`);
  }
  if (identifier.length > MAX_IDENTIFIER_LENGTH) {
    throw badRequest(`${label}长度不能超过 ${MAX_IDENTIFIER_LENGTH} 个字符。`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(identifier)) {
    throw badRequest(`${label}包含非法控制字符。`);
  }
  return identifier;
}

function quoteIdentifier(value, label = '标识符') {
  return `\`${normalizeIdentifier(value, label).replace(/`/g, '``')}\``;
}

function normalizeColumns(columns) {
  if (!Array.isArray(columns)) {
    throw badRequest('无法验证表字段元数据。');
  }
  return columns.map((column) => ({
    ...column,
    columnName: String(column?.columnName || '').trim(),
    columnType: String(column?.columnType || '').trim(),
    columnComment: String(column?.columnComment || '').trim()
  })).filter((column) => column.columnName);
}

function resolveTemplateField({ fields, role, columns, fallback }) {
  const requested = String(fields?.[role] || '').trim();
  const fieldName = requested || String(fallback || '').trim();
  if (!fieldName) {
    const roleLabel = role === 'timeField' ? '时间字段' : '区域字段';
    throw badRequest(`当前表未检测到可用${roleLabel}，请明确选择字段。`);
  }

  const matched = columns.find((column) => column.columnName === fieldName);
  if (!matched) {
    throw badRequest(`字段“${fieldName}”不属于当前数据库表。`);
  }
  if (UNSAFE_TEMPLATE_FIELD_TYPE_PATTERN.test(matched.columnType)) {
    throw badRequest(`字段“${fieldName}”的类型不适用于当前模板。`);
  }
  return matched.columnName;
}

const TEMPLATE_REGISTRY = Object.freeze({
  'time-range': Object.freeze({
    name: '查询时间范围',
    description: '自动识别时间字段并返回最早与最晚日期',
    fieldRole: 'timeField',
    sideEffects: Object.freeze([]),
    build(context) {
      const timeField = resolveTemplateField({
        fields: context.fields,
        role: 'timeField',
        columns: context.columns,
        fallback: buildDetectedFields(context.columns).timeField
      });
      return {
        sql: [
          'SELECT',
          `    DATE(MIN(${quoteIdentifier(timeField, '时间字段')})) AS earliest_record,`,
          `    DATE(MAX(${quoteIdentifier(timeField, '时间字段')})) AS latest_record`,
          `FROM ${context.qualifiedTable}`
        ].join('\n'),
        params: []
      };
    }
  }),
  'region-distribution': Object.freeze({
    name: '查询区域分布',
    description: '自动识别区域字段并列出区域值',
    fieldRole: 'regionField',
    sideEffects: Object.freeze([]),
    build(context) {
      const regionField = resolveTemplateField({
        fields: context.fields,
        role: 'regionField',
        columns: context.columns,
        fallback: buildDetectedFields(context.columns).regionField
      });
      return {
        sql: `SELECT DISTINCT LEFT(CAST(${quoteIdentifier(regionField, '区域字段')} AS CHAR), ${REGION_VALUE_CHARACTER_LIMIT}) AS ${quoteIdentifier(regionField, '区域字段')}\nFROM ${context.qualifiedTable}\nLIMIT ${REGION_RESULT_LIMIT + 1}`,
        params: [],
        resultLimit: REGION_RESULT_LIMIT,
        cellCharacterLimit: REGION_VALUE_CHARACTER_LIMIT
      };
    }
  }),
  'total-rows': Object.freeze({
    name: '查询总行数',
    description: '统计当前表总行数，并显示表名称',
    fieldRole: null,
    sideEffects: Object.freeze([]),
    build(context) {
      return {
        sql: `SELECT ? AS 表名称, COUNT(1) AS 总行数\nFROM ${context.qualifiedTable}`,
        params: [context.tableLabel]
      };
    }
  }),
  'table-structure': Object.freeze({
    name: '查询表结构',
    description: '查看当前表的字段、类型、默认值和注释',
    fieldRole: null,
    sideEffects: Object.freeze([]),
    captureOptions: Object.freeze({ hideSql: true, showTableMeta: true }),
    build(context) {
      return {
        sql: [
          'SELECT',
          '    ORDINAL_POSITION AS 序号,',
          '    COLUMN_NAME AS 字段名,',
          '    COLUMN_TYPE AS 类型,',
          "    CASE WHEN IS_NULLABLE = 'YES' THEN '是' ELSE '否' END AS 可空,",
          "    COALESCE(COLUMN_DEFAULT, 'NULL') AS 默认值,",
          "    COALESCE(NULLIF(COLUMN_COMMENT, ''), '暂无字段注释') AS 注释",
          'FROM information_schema.COLUMNS',
          'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
          'ORDER BY ORDINAL_POSITION'
        ].join('\n'),
        params: [context.database, context.table]
      };
    }
  }),
  'storage-usage': Object.freeze({
    name: '查询存储空间',
    description: '查看当前表的存储空间占用',
    fieldRole: null,
    sideEffects: Object.freeze(['analyze-table']),
    build(context) {
      return {
        sql: [
          'SELECT CONCAT(',
          '    ?,',
          '    ROUND(COALESCE(SUM(data_length + index_length), 0) / 1024 / 1024, 2),',
          '    ?',
          ') AS table_description',
          'FROM information_schema.TABLES',
          'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?'
        ].join('\n'),
        params: [`${context.tableLabel}当前占用 `, 'MB 存储空间', context.database, context.table]
      };
    }
  })
});

function listPublicTemplates() {
  return Object.entries(TEMPLATE_REGISTRY).map(([id, template]) => ({
    id,
    name: template.name,
    description: template.description,
    fieldRole: template.fieldRole,
    sideEffects: [...template.sideEffects]
  }));
}

function buildTemplateQuery({ templateId, database, table, tableComment = '', fields = {}, columns = [] }) {
  const safeTemplateId = String(templateId || '').trim();
  if (!Object.hasOwn(TEMPLATE_REGISTRY, safeTemplateId)) {
    throw badRequest('未知或不受支持的查询模板。');
  }
  const template = TEMPLATE_REGISTRY[safeTemplateId];

  const safeDatabase = normalizeIdentifier(database, '数据库名称');
  const safeTable = normalizeIdentifier(table, '表名称');
  const safeColumns = normalizeColumns(columns);
  const tableLabel = String(tableComment || '').trim() || safeTable;
  const built = template.build({
    database: safeDatabase,
    table: safeTable,
    tableLabel,
    fields: fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {},
    columns: safeColumns,
    qualifiedTable: `${quoteIdentifier(safeDatabase, '数据库名称')}.${quoteIdentifier(safeTable, '表名称')}`
  });

  return {
    templateId: safeTemplateId,
    templateName: template.name,
    captureOptions: template.captureOptions || Object.freeze({}),
    sql: built.sql,
    params: built.params,
    resultLimit: built.resultLimit || null,
    cellCharacterLimit: built.cellCharacterLimit || null
  };
}

function resolveCaptureFileName(templateId, imageName) {
  return Object.hasOwn(CAPTURE_FILE_NAME_BY_TEMPLATE_ID, templateId)
    ? CAPTURE_FILE_NAME_BY_TEMPLATE_ID[templateId]
    : imageName || 'capture';
}

function detectColumn(columns, candidates, typePattern, namePattern) {
  if (!Array.isArray(columns) || !columns.length) {
    return null;
  }
  for (const candidate of candidates) {
    const matched = columns.find((column) => String(column.columnName || '').toLowerCase() === candidate);
    if (matched) {
      return matched.columnName;
    }
  }
  if (namePattern) {
    const matched = columns.find((column) => namePattern.test(String(column.columnName || '').toLowerCase()));
    if (matched) {
      return matched.columnName;
    }
  }
  if (typePattern) {
    const matched = columns.find((column) => typePattern.test(String(column.columnType || '').toLowerCase()));
    if (matched) {
      return matched.columnName;
    }
  }
  return null;
}

function dedupeFieldNames(names) {
  const seen = new Set();
  return names.filter((name) => {
    const key = String(name || '').trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isTimeCandidateColumn(column) {
  const name = String(column?.columnName || '').toLowerCase();
  const type = String(column?.columnType || '').toLowerCase();
  const comment = String(column?.columnComment || '').trim();
  if (!name || /(blob|binary|varbinary|json)/.test(type)) {
    return false;
  }
  return /(date|time|timestamp|datetime)/.test(type)
    || TIME_FIELD_CANDIDATES.includes(name)
    || TIME_FIELD_NAME_PATTERN.test(name)
    || TIME_FIELD_COMMENT_PATTERN.test(comment);
}

function buildFieldCandidates(columns) {
  const timeFields = dedupeFieldNames(columns.filter((column) => isTimeCandidateColumn(column)).map((column) => column.columnName));
  const regionFields = dedupeFieldNames(
    columns.filter((column) => {
      const name = String(column.columnName || '').toLowerCase();
      const type = String(column.columnType || '').toLowerCase();
      const comment = String(column.columnComment || '').trim();
      if (REGION_FIELD_EXCLUDE_PATTERN.test(name) || /(blob|binary|varbinary|json)/.test(type)) {
        return false;
      }
      return REGION_FIELD_CANDIDATES.includes(name)
        || REGION_FIELD_NAME_PATTERN.test(name)
        || REGION_FIELD_COMMENT_PATTERN.test(comment);
    }).map((column) => column.columnName)
  );
  return { timeFields, regionFields };
}

function buildDetectedFields(columns) {
  const timeColumns = columns.filter((column) => isTimeCandidateColumn(column));
  return {
    timeField: detectColumn(timeColumns, TIME_FIELD_CANDIDATES, /(date|time|timestamp|datetime)/, TIME_FIELD_NAME_PATTERN),
    regionField: detectColumn(columns, REGION_AUTO_FIELD_CANDIDATES, null)
  };
}

function buildTemplateAvailability(detectedFields, fieldCandidates = { timeFields: [], regionFields: [] }) {
  const timeHint = fieldCandidates.timeFields.length
    ? `，可候选字段：${fieldCandidates.timeFields.slice(0, 6).join('、')}${fieldCandidates.timeFields.length > 6 ? ' 等' : ''}`
    : '';
  const regionHint = fieldCandidates.regionFields.length
    ? `，可候选字段：${fieldCandidates.regionFields.slice(0, 6).join('、')}${fieldCandidates.regionFields.length > 6 ? ' 等' : ''}`
    : '';

  return {
    'time-range': detectedFields.timeField
      ? { supported: true, field: detectedFields.timeField }
      : { supported: false, reason: `未自动识别到可用时间字段${timeHint}，请先在试跑表中指定。` },
    'region-distribution': detectedFields.regionField
      ? { supported: true, field: detectedFields.regionField }
      : { supported: false, reason: `未自动识别到可用区域字段${regionHint}，请先在试跑表中指定。` },
    'total-rows': { supported: true },
    'table-structure': { supported: true },
    'storage-usage': { supported: true }
  };
}

function guessTaskFailureReason(error, context = {}) {
  const message = String(error?.message || '').trim();
  const sql = String(context.sql || '').trim();
  const templateName = String(context.templateName || '').trim();

  if (sql.startsWith('--')) {
    return sql.slice(2).trim() || '当前任务缺少可执行 SQL。';
  }
  if (message.includes('未检测到可用于截图的浏览器')) {
    return '本机未检测到可用于截图的浏览器。';
  }
  if (message.includes('截图超时')) {
    return '截图超时，浏览器未在限定时间内生成图片。';
  }
  if (message.includes('没有生成有效的 PNG 文件')) {
    return '截图进程已结束，但没有生成有效图片。';
  }
  if (error?.code === 'ER_BAD_FIELD_ERROR') {
    return templateName ? `模板“${templateName}”依赖的字段在当前表中不存在。` : 'SQL 使用了当前表不存在的字段。';
  }
  if (error?.code === 'ER_NO_SUCH_TABLE') {
    return '目标表不存在，可能已被删除或名称发生变化。';
  }
  if (error?.code === 'PROTOCOL_CONNECTION_LOST') {
    return '数据库连接中断，请重新连接后再试。';
  }
  if (error?.code === 'ECONNREFUSED') {
    return '数据库拒绝连接，请检查数据库服务状态。';
  }
  if (message.includes('仅允许执行')) {
    return '任务 SQL 未通过只读校验，已阻止执行。';
  }
  if (message.includes('SQL 不能为空')) {
    return '任务 SQL 为空，无法执行。';
  }
  if (message.includes('当前表未检测到可用时间字段') || message.includes('当前表未检测到可用区域字段')) {
    return message;
  }
  return '任务执行失败，请查看本地日志获取详细信息。';
}

module.exports = {
  CAPTURE_FILE_NAME_BY_TEMPLATE_ID,
  buildTemplateQuery,
  buildDetectedFields,
  buildFieldCandidates,
  buildTemplateAvailability,
  guessTaskFailureReason,
  listPublicTemplates,
  resolveCaptureFileName
};
