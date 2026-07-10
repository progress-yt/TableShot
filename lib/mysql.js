const mysql = require('mysql2');
const mysqlPromise = require('mysql2/promise');

const DEFAULT_CONNECTION_LIMIT = 6;
const DEFAULT_POOL_QUEUE_LIMIT = 24;
const DEFAULT_QUERY_TIMEOUT_MS = 15_000;
const MAX_DATABASES = 500;
const MAX_TABLES_PER_DATABASE = 1_000;
const MAX_COLUMNS_PER_DATABASE = 20_000;
const MAX_COLUMNS_PER_TABLE = 2_000;
const MAX_PREVIEW_ROWS = 100;
const MAX_PREVIEW_COLUMNS = 64;
const MAX_PREVIEW_TEXT_CHARS = 512;
const BINARY_PREVIEW_TYPE_PATTERN = /(?:blob|binary|varbinary|bit|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|vector)/u;
const TEXT_PREVIEW_TYPE_PATTERN = /(?:char|text|json|enum|set)/u;

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = statusCode < 500;
  return error;
}

function validateName(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw httpError(400, `${label}不能为空。`);
  }
  if (normalized.length > 64 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw httpError(400, `${label}格式非法。`);
  }
  return normalized;
}

function quoteSingleIdentifier(value, label) {
  return mysql.escapeId(validateName(value, label), true);
}

function createMysqlService(options) {
  const {
    state,
    normalizeRows,
    defaultPreviewLimit,
    buildDetectedFields,
    buildFieldCandidates,
    buildTemplateAvailability,
    buildTemplateQuery,
    queryTimeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
    connectionLimit = DEFAULT_CONNECTION_LIMIT,
    poolQueueLimit = DEFAULT_POOL_QUEUE_LIMIT,
    poolFactory = (config) => mysqlPromise.createPool(config)
  } = options;

  if (!state || typeof state !== 'object') {
    throw new TypeError('createMysqlService requires a mutable state object.');
  }
  if (typeof buildTemplateQuery !== 'function') {
    throw new TypeError('createMysqlService requires buildTemplateQuery.');
  }

  const safeQueryTimeoutMs = Math.max(1_000, Math.min(120_000, Number(queryTimeoutMs) || DEFAULT_QUERY_TIMEOUT_MS));
  const safeConnectionLimit = Math.max(1, Math.min(16, Number(connectionLimit) || DEFAULT_CONNECTION_LIMIT));
  const safePoolQueueLimit = Math.max(1, Math.min(100, Number(poolQueueLimit) || DEFAULT_POOL_QUEUE_LIMIT));
  let replacementQueue = Promise.resolve();

  function createConnectionPool(config) {
    return poolFactory({
      ...config,
      multipleStatements: false,
      waitForConnections: true,
      connectionLimit: safeConnectionLimit,
      maxIdle: safeConnectionLimit,
      idleTimeout: 60_000,
      queueLimit: safePoolQueueLimit,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      maxPreparedStatements: 256
    });
  }

  function publicConnectionConfig() {
    if (!state.connectionConfig) {
      return null;
    }
    return {
      host: state.connectionConfig.host,
      port: state.connectionConfig.port,
      user: state.connectionConfig.user
    };
  }

  function assertConnected() {
    if (!state.connectionConfig || !state.connectionPool) {
      throw httpError(400, '尚未建立数据库连接。请先在页面上完成连接。');
    }
  }

  function ensureConnectionPool() {
    assertConnected();
    return state.connectionPool;
  }

  async function runQuery(connection, sql, params = []) {
    const options = { sql, timeout: safeQueryTimeoutMs };
    if (params.length) {
      return connection.execute(options, params);
    }
    return connection.query(options);
  }

  function formatDisplayValue(value) {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw httpError(500, '无法格式化非有限数值。');
      }
      return String(value);
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'boolean') {
      return value ? '1' : '0';
    }
    const text = value instanceof Date
      ? value.toISOString()
      : Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    const buffer = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    return `CONVERT(0x${buffer.toString('hex')} USING utf8mb4)`;
  }

  function formatSqlForDisplay(sql, params) {
    let parameterIndex = 0;
    let displaySql = '';
    let quote = '';
    for (let index = 0; index < sql.length; index += 1) {
      const character = sql[index];
      if (quote) {
        displaySql += character;
        if (character === '\\' && quote !== '`' && index + 1 < sql.length) {
          displaySql += sql[index + 1];
          index += 1;
        } else if (character === quote) {
          if (sql[index + 1] === quote) {
            displaySql += sql[index + 1];
            index += 1;
          } else {
            quote = '';
          }
        }
        continue;
      }
      if (character === '\'' || character === '"' || character === '`') {
        quote = character;
        displaySql += character;
        continue;
      }
      if (character !== '?') {
        displaySql += character;
        continue;
      }
      if (parameterIndex >= params.length) {
        throw httpError(500, '模板 SQL 参数数量不匹配。');
      }
      displaySql += formatDisplayValue(params[parameterIndex]);
      parameterIndex += 1;
    }
    if (parameterIndex !== params.length) {
      throw httpError(500, '模板 SQL 参数数量不匹配。');
    }
    return `${displaySql.trimEnd().replace(/;+$/u, '')};`;
  }

  async function withPoolConnection(pool, fn) {
    const connection = await pool.getConnection();
    try {
      return await fn(connection);
    } finally {
      connection.release();
    }
  }

  async function withConnection(_database, fn) {
    return withPoolConnection(ensureConnectionPool(), fn);
  }

  function buildQueryResult(rows, fields) {
    const normalized = normalizeRows(rows, fields);
    const columns = fields && fields.length
      ? fields.map((field) => field.name)
      : Object.keys(normalized[0] || {});
    return { columns, rows: normalized };
  }

  async function listDatabasesFromConnection(connection) {
    const [rows] = await runQuery(
      connection,
      `SELECT SCHEMA_NAME AS \`Database\`
         FROM information_schema.SCHEMATA
        ORDER BY SCHEMA_NAME
        LIMIT ${MAX_DATABASES + 1}`
    );
    if (rows.length > MAX_DATABASES) {
      throw httpError(413, `数据库数量超过 ${MAX_DATABASES} 个安全上限。`);
    }
    return rows.map((row) => row.Database).filter(Boolean);
  }

  async function replaceConnectionNow(config) {
    const newPool = createConnectionPool(config);
    let version = 'unknown';
    let databases;

    try {
      ({ version, databases } = await withPoolConnection(newPool, async (connection) => {
        const [versionRows] = await runQuery(connection, 'SELECT VERSION() AS version');
        const availableDatabases = await listDatabasesFromConnection(connection);
        return {
          version: versionRows[0]?.version ? String(versionRows[0].version) : 'unknown',
          databases: availableDatabases
        };
      }));
    } catch (error) {
      await newPool.end().catch(() => {});
      throw error;
    }

    const oldPool = state.connectionPool;
    state.connectionConfig = { ...config };
    state.connectionPool = newPool;
    state.connectionHealthy = true;
    state.lastConnectionError = null;
    state.lastHealthCheckAt = new Date().toISOString();

    if (oldPool && oldPool !== newPool) {
      await oldPool.end().catch(() => {});
    }

    return { version, databases };
  }

  function replaceConnection(config) {
    const operation = replacementQueue.then(() => replaceConnectionNow(config));
    replacementQueue = operation.catch(() => {});
    return operation;
  }

  async function closeConnectionPool() {
    await replacementQueue.catch(() => {});
    const pool = state.connectionPool;
    state.connectionPool = null;
    state.connectionConfig = null;
    state.connectionHealthy = false;
    if (pool) {
      await pool.end().catch(() => {});
    }
  }

  async function getStatus() {
    const connection = publicConnectionConfig();
    if (!state.connectionConfig || !state.connectionPool) {
      return { connected: false, health: 'disconnected', connection, lastCheckedAt: null };
    }

    try {
      await withPoolConnection(state.connectionPool, async (poolConnection) => {
        await runQuery(poolConnection, 'SELECT 1 AS health');
      });
      state.connectionHealthy = true;
      state.lastConnectionError = null;
      state.lastHealthCheckAt = new Date().toISOString();
      return {
        connected: true,
        health: 'healthy',
        connection,
        lastCheckedAt: state.lastHealthCheckAt
      };
    } catch (error) {
      state.connectionHealthy = false;
      state.lastConnectionError = String(error?.code || error?.message || 'unknown');
      state.lastHealthCheckAt = new Date().toISOString();
      return {
        connected: false,
        health: 'unhealthy',
        connection,
        lastCheckedAt: state.lastHealthCheckAt
      };
    }
  }

  async function getTableMetadataWithConnection(connection, database, table) {
    const safeDatabase = validateName(database, '数据库名称');
    const safeTable = validateName(table, '表名称');
    const [tableRows] = await runQuery(
      connection,
      `SELECT TABLE_NAME AS tableName, TABLE_COMMENT AS tableComment, TABLE_TYPE AS tableType, ENGINE AS engine
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        LIMIT 1`,
      [safeDatabase, safeTable]
    );
    if (!tableRows.length) {
      throw httpError(404, '目标数据库表不存在。');
    }

    const [columnRows] = await runQuery(
      connection,
      `SELECT ORDINAL_POSITION AS ordinalPosition, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType,
              IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS columnDefault, COLUMN_COMMENT AS columnComment
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
        LIMIT ${MAX_COLUMNS_PER_TABLE + 1}`,
      [safeDatabase, safeTable]
    );
    if (columnRows.length > MAX_COLUMNS_PER_TABLE) {
      throw httpError(413, `字段数量超过 ${MAX_COLUMNS_PER_TABLE} 个安全上限。`);
    }
    return {
      database: safeDatabase,
      table: safeTable,
      tableInfo: normalizeRows(tableRows)[0],
      columns: normalizeRows(columnRows)
    };
  }

  async function executeTemplateQuery(database, request = {}) {
    if (Object.prototype.hasOwnProperty.call(request, 'sql')) {
      throw httpError(400, '结构化查询不接受客户端 SQL。');
    }
    const safeDatabase = validateName(database, '数据库名称');
    const safeTable = validateName(request.table, '表名称');
    return withConnection(null, async (connection) => {
      const metadata = await getTableMetadataWithConnection(connection, safeDatabase, safeTable);
      const query = buildTemplateQuery({
        templateId: request.templateId,
        database: metadata.database,
        table: metadata.table,
        tableComment: metadata.tableInfo.tableComment,
        columns: metadata.columns,
        fields: request.fields
      });
      const [rows, fields] = await runQuery(connection, query.sql, query.params);
      const result = buildQueryResult(rows, fields);
      result.totalRowCount = result.rows.length;
      if (query.resultLimit && result.rows.length > query.resultLimit) {
        result.rows = result.rows.slice(0, query.resultLimit);
        result.truncated = true;
      } else {
        result.truncated = false;
      }
      result.totalRowCountExact = !result.truncated;
      if (query.cellCharacterLimit) {
        result.cellCharacterLimit = query.cellCharacterLimit;
      }
      return {
        // Display-only SQL. Execution above always uses prepared statements for params.
        sql: formatSqlForDisplay(query.sql, query.params),
        result,
        tableComment: metadata.tableInfo.tableComment || '',
        templateName: query.templateName,
        captureOptions: query.captureOptions
      };
    });
  }

  async function previewTemplateQuery(database, request = {}) {
    if (Object.prototype.hasOwnProperty.call(request, 'sql')) {
      throw httpError(400, '结构化查询不接受客户端 SQL。');
    }
    const safeDatabase = validateName(database, '数据库名称');
    const safeTable = validateName(request.table, '表名称');
    return withConnection(null, async (connection) => {
      const metadata = await getTableMetadataWithConnection(connection, safeDatabase, safeTable);
      const query = buildTemplateQuery({
        templateId: request.templateId,
        database: metadata.database,
        table: metadata.table,
        tableComment: metadata.tableInfo.tableComment,
        columns: metadata.columns,
        fields: request.fields
      });
      return {
        // Display-only SQL. Never feed this formatted string back into execution.
        sql: formatSqlForDisplay(query.sql, query.params),
        template: { id: query.templateId, name: query.templateName },
        tableComment: metadata.tableInfo.tableComment || '',
        captureOptions: query.captureOptions
      };
    });
  }

  async function listDatabases() {
    return withConnection(null, listDatabasesFromConnection);
  }

  async function listTables(database) {
    const safeDatabase = validateName(database, '数据库名称');
    return withConnection(null, async (connection) => {
      const [tableRows] = await runQuery(
        connection,
        `SELECT TABLE_NAME AS tableName, TABLE_COMMENT AS tableComment, TABLE_TYPE AS tableType, ENGINE AS engine, TABLE_ROWS AS tableRows,
                CREATE_TIME AS createTime, UPDATE_TIME AS updateTime
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ?
          ORDER BY TABLE_NAME
          LIMIT ${MAX_TABLES_PER_DATABASE + 1}`,
        [safeDatabase]
      );
      const normalizedTables = normalizeRows(tableRows);
      if (normalizedTables.length > MAX_TABLES_PER_DATABASE) {
        throw httpError(413, `表数量超过 ${MAX_TABLES_PER_DATABASE} 个安全上限。`);
      }
      const [columnRows] = await runQuery(
        connection,
        `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType, COLUMN_COMMENT AS columnComment
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ?
          ORDER BY TABLE_NAME, ORDINAL_POSITION
          LIMIT ${MAX_COLUMNS_PER_DATABASE + 1}`,
        [safeDatabase]
      );

      const normalizedColumns = normalizeRows(columnRows);
      if (normalizedColumns.length > MAX_COLUMNS_PER_DATABASE) {
        throw httpError(413, `字段总数超过 ${MAX_COLUMNS_PER_DATABASE} 个安全上限。`);
      }
      const columnsByTable = new Map();
      normalizedColumns.forEach((column) => {
        const tableName = String(column.tableName || '');
        if (!columnsByTable.has(tableName)) {
          columnsByTable.set(tableName, []);
        }
        columnsByTable.get(tableName).push({
          columnName: column.columnName,
          columnType: column.columnType,
          columnComment: column.columnComment
        });
      });

      return normalizedTables.map((tableInfo) => {
        const tableColumns = columnsByTable.get(tableInfo.tableName) || [];
        const detectedFields = buildDetectedFields(tableColumns);
        const fieldCandidates = buildFieldCandidates(tableColumns);
        return {
          ...tableInfo,
          detectedFields,
          fieldCandidates,
          templateAvailability: buildTemplateAvailability(detectedFields, fieldCandidates)
        };
      });
    });
  }

  async function listColumns(database, table) {
    return withConnection(null, async (connection) => {
      const metadata = await getTableMetadataWithConnection(connection, database, table);
      return metadata.columns;
    });
  }

  async function previewTable(database, table, limit) {
    const safeLimit = Math.max(1, Math.min(MAX_PREVIEW_ROWS, Math.trunc(Number(limit) || defaultPreviewLimit)));
    return withConnection(null, async (connection) => {
      const metadata = await getTableMetadataWithConnection(connection, database, table);
      const previewColumns = metadata.columns.slice(0, MAX_PREVIEW_COLUMNS);
      const projection = previewColumns.map((column) => {
        const identifier = quoteSingleIdentifier(column.columnName, '字段名称');
        const type = String(column.columnType || '').toLowerCase();
        if (BINARY_PREVIEW_TYPE_PATTERN.test(type)) {
          return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE CONCAT('[binary ', OCTET_LENGTH(${identifier}), ' bytes]') END AS ${identifier}`;
        }
        if (TEXT_PREVIEW_TYPE_PATTERN.test(type)) {
          return `LEFT(CAST(${identifier} AS CHAR), ${MAX_PREVIEW_TEXT_CHARS}) AS ${identifier}`;
        }
        return identifier;
      });
      if (!projection.length) {
        throw httpError(400, '目标表没有可预览的字段。');
      }
      const sql = `SELECT ${projection.join(', ')} FROM ${quoteSingleIdentifier(metadata.database, '数据库名称')}.${quoteSingleIdentifier(metadata.table, '表名称')} LIMIT ${safeLimit + 1}`;
      const [rows, fields] = await runQuery(connection, sql);
      const result = buildQueryResult(rows.slice(0, safeLimit), fields);
      result.rowLimit = safeLimit;
      result.truncatedRows = rows.length > safeLimit;
      result.totalColumnCount = metadata.columns.length;
      result.returnedColumnCount = previewColumns.length;
      result.truncatedColumns = metadata.columns.length > previewColumns.length;
      result.cellCharacterLimit = MAX_PREVIEW_TEXT_CHARS;
      result.binaryValuesSummarized = previewColumns.some((column) =>
        BINARY_PREVIEW_TYPE_PATTERN.test(String(column.columnType || '').toLowerCase())
      );
      return result;
    });
  }

  async function analyzeTable(database, table) {
    return withConnection(null, async (connection) => {
      const metadata = await getTableMetadataWithConnection(connection, database, table);
      const [rows] = await runQuery(
        connection,
        `ANALYZE TABLE ${quoteSingleIdentifier(metadata.database, '数据库名称')}.${quoteSingleIdentifier(metadata.table, '表名称')}`
      );
      return normalizeRows(rows);
    });
  }

  return {
    analyzeTable,
    assertConnected,
    closeConnectionPool,
    createConnectionPool,
    executeTemplateQuery,
    getStatus,
    listColumns,
    listDatabases,
    listTables,
    previewTable,
    previewTemplateQuery,
    replaceConnection
  };
}

module.exports = {
  DEFAULT_POOL_QUEUE_LIMIT,
  DEFAULT_QUERY_TIMEOUT_MS,
  createMysqlService
};
