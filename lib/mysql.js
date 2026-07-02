const mysql = require('mysql2');
const mysqlPromise = require('mysql2/promise');

function createMysqlService(options) {
  const {
    state,
    normalizeRows,
    defaultPreviewLimit,
    buildDetectedFields,
    buildFieldCandidates,
    buildTemplateAvailability,
    assertAllowedQuery,
    assertReadOnlySql,
    isAllowedTemplateQuery
  } = options;

  function createConnectionPool(config) {
    return mysqlPromise.createPool({
      ...config,
      waitForConnections: true,
      connectionLimit: 6,
      maxIdle: 6,
      idleTimeout: 60_000,
      queueLimit: 0
    });
  }

  async function closeConnectionPool() {
    if (!state.connectionPool) {
      return;
    }
    const pool = state.connectionPool;
    state.connectionPool = null;
    await pool.end().catch(() => {});
  }

  function ensureConnectionPool() {
    if (!state.connectionConfig) {
      const error = new Error('尚未建立数据库连接。请先在页面上完成连接。');
      error.statusCode = 400;
      throw error;
    }
    if (!state.connectionPool) {
      state.connectionPool = createConnectionPool(state.connectionConfig);
    }
    return state.connectionPool;
  }

  async function withConnection(database, fn) {
    const pool = ensureConnectionPool();
    const connection = await pool.getConnection();
    try {
      if (database) {
        await connection.query(`USE ${mysql.escapeId(database)}`);
      }
      return await fn(connection);
    } finally {
      connection.release();
    }
  }

  function buildQueryResult(rows, fields) {
    const normalized = normalizeRows(rows, fields);
    const columns = fields && fields.length ? fields.map((field) => field.name) : Object.keys(normalized[0] || {});
    return { columns, rows: normalized };
  }

  async function executeReadOnlyQuery(database, sql) {
    const checkedSql = isAllowedTemplateQuery(sql)
      ? assertAllowedQuery(sql)
      : assertReadOnlySql(sql);
    return withConnection(database, async (connection) => {
      const [rows, fields] = await connection.query(checkedSql);
      return buildQueryResult(rows, fields);
    });
  }

  async function listDatabases() {
    return withConnection(null, async (connection) => {
      const [rows] = await connection.query('SHOW DATABASES');
      return rows.map((row) => row.Database).filter(Boolean);
    });
  }

  async function listTables(database) {
    return withConnection(database, async (connection) => {
      const [tableRows, columnRows] = await Promise.all([
        connection.query(
          `SELECT TABLE_NAME AS tableName, TABLE_COMMENT AS tableComment, TABLE_TYPE AS tableType, ENGINE AS engine, TABLE_ROWS AS tableRows,
                  CREATE_TIME AS createTime, UPDATE_TIME AS updateTime
             FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME`,
          [database]
        ),
        connection.query(
          `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType, COLUMN_COMMENT AS columnComment
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME, ORDINAL_POSITION`,
          [database]
        )
      ]);

      const normalizedTables = normalizeRows(tableRows[0]);
      const normalizedColumns = normalizeRows(columnRows[0]);
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

      return normalizedTables.map((table) => {
        const tableColumns = columnsByTable.get(table.tableName) || [];
        const detectedFields = buildDetectedFields(tableColumns);
        const fieldCandidates = buildFieldCandidates(tableColumns);
        return {
          ...table,
          detectedFields,
          fieldCandidates,
          templateAvailability: buildTemplateAvailability(detectedFields, fieldCandidates)
        };
      });
    });
  }

  async function listColumns(database, table) {
    return withConnection(database, async (connection) => {
      const [rows] = await connection.query(
        `SELECT ORDINAL_POSITION AS ordinalPosition, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType,
                IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS columnDefault, COLUMN_COMMENT AS columnComment
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [database, table]
      );
      return normalizeRows(rows);
    });
  }

  async function previewTable(database, table, limit) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || defaultPreviewLimit));
    const sql = `SELECT * FROM ${mysql.escapeId(database)}.${mysql.escapeId(table)} LIMIT ${safeLimit}`;
    return executeReadOnlyQuery(database, sql);
  }

  async function analyzeTable(database, table) {
    return withConnection(database, async (connection) => {
      const [rows] = await connection.query(`ANALYZE TABLE ${mysql.escapeId(table)}`);
      return normalizeRows(rows);
    });
  }

  return {
    analyzeTable,
    closeConnectionPool,
    createConnectionPool,
    executeReadOnlyQuery,
    listColumns,
    listDatabases,
    listTables,
    previewTable,
    withConnection
  };
}

module.exports = {
  createMysqlService
};
