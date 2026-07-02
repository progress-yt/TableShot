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

function resolveCaptureFileName(templateId, imageName) {
  return CAPTURE_FILE_NAME_BY_TEMPLATE_ID[templateId] || imageName || 'capture';
}

function stripLeadingComments(sql) {
  let result = String(sql || '').trim();
  let changed = true;

  while (changed) {
    changed = false;
    if (result.startsWith('--') || result.startsWith('#')) {
      const nextLine = result.indexOf('\n');
      result = nextLine === -1 ? '' : result.slice(nextLine + 1).trimStart();
      changed = true;
    }
    if (result.startsWith('/*')) {
      const end = result.indexOf('*/');
      if (end === -1) {
        break;
      }
      result = result.slice(end + 2).trimStart();
      changed = true;
    }
  }

  return result;
}

function normalizeSqlForWhitelist(sql) {
  return stripLeadingComments(sql)
    .replace(/;+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isAllowedTableStructureQuery(normalized) {
  return normalized.startsWith('select ordinal_position as')
    && normalized.includes(' from information_schema.columns ')
    && normalized.includes(' where table_schema = database() ')
    && / and table_name = '.*' order by ordinal_position$/i.test(normalized);
}

function isAllowedTemplateQuery(sql) {
  const normalized = normalizeSqlForWhitelist(sql);
  if (isAllowedTableStructureQuery(normalized)) {
    return true;
  }

  const patterns = [
    /^select date\(min\([`\w]+\)\) as earliest_record, date\(max\([`\w]+\)\) as latest_record from [`\w.]+$/i,
    /^select distinct [`\w]+ from [`\w.]+$/i,
    /^select '.*' as .*, count\(1\) as .* from [`\w.]+$/i,
    /^show full columns from [`\w.]+$/i,
    /^select concat\( '.*', round\(sum\(data_length \+ index_length\) \/ 1024 \/ 1024, 2\), 'mb .*' \) as table_description from information_schema\.tables where table_schema = database\(\) and table_name = '.*'$/i
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function assertAllowedQuery(sql) {
  const normalized = normalizeSqlForWhitelist(sql);
  if (!normalized) {
    const error = new Error('SQL 不能为空。');
    error.statusCode = 400;
    throw error;
  }
  if (!isAllowedTemplateQuery(sql)) {
    const error = new Error('SQL 编辑器当前仅允许执行预设模板查询。');
    error.statusCode = 400;
    throw error;
  }
  return String(sql || '').trim().replace(/;+\s*$/g, '');
}

function assertReadOnlySql(sql) {
  const trimmed = stripLeadingComments(String(sql || '').trim());
  const normalized = trimmed.replace(/;+\s*$/, '');

  if (!normalized) {
    const error = new Error('SQL 不能为空。');
    error.statusCode = 400;
    throw error;
  }
  if (/;/.test(normalized)) {
    const error = new Error('仅允许执行单条只读 SQL。');
    error.statusCode = 400;
    throw error;
  }
  if (!/^(select|with|show|describe|desc|explain)\b/i.test(normalized)) {
    const error = new Error('为了安全起见，仅允许执行 SELECT / WITH / SHOW / DESCRIBE / EXPLAIN。');
    error.statusCode = 400;
    throw error;
  }

  return normalized;
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
  assertAllowedQuery,
  assertReadOnlySql,
  buildDetectedFields,
  buildFieldCandidates,
  buildTemplateAvailability,
  guessTaskFailureReason,
  isAllowedTemplateQuery,
  normalizeSqlForWhitelist,
  resolveCaptureFileName
};
