const assert = require('node:assert/strict');
const test = require('node:test');

const { createMysqlService } = require('../lib/mysql');
const { buildTemplateQuery } = require('../lib/templates');

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows : [rows];
}

function makeConnection(queryHandler) {
  return {
    released: false,
    async query(options, params) {
      return queryHandler(options, params, 'query');
    },
    async execute(options, params) {
      return queryHandler(options, params, 'execute');
    },
    release() {
      this.released = true;
    }
  };
}

function makePool(connection) {
  return {
    ended: false,
    async getConnection() {
      if (connection instanceof Error) {
        throw connection;
      }
      return connection;
    },
    async end() {
      this.ended = true;
    }
  };
}

function makeService({ state = {}, pools = [], queryTimeoutMs = 4321 } = {}) {
  const poolConfigs = [];
  const service = createMysqlService({
    state,
    normalizeRows,
    defaultPreviewLimit: 30,
    buildDetectedFields: () => ({}),
    buildFieldCandidates: () => ({ timeFields: [], regionFields: [] }),
    buildTemplateAvailability: () => ({}),
    buildTemplateQuery,
    queryTimeoutMs,
    poolFactory(config) {
      poolConfigs.push(config);
      const pool = pools.shift();
      assert.ok(pool, 'test pool must be supplied');
      return pool;
    }
  });
  return { service, poolConfigs };
}

test('MySQL service exposes only structured operations, not a raw connection seam', () => {
  const { service } = makeService();
  assert.equal(service.withConnection, undefined);
  assert.equal(service.executeReadOnlyQuery, undefined);
});

test('pool queue is finite and every query receives a timeout', async () => {
  const seen = [];
  const connection = makeConnection(async (options) => {
    seen.push(options);
    return [[{ Database: 'analytics' }], [{ name: 'Database' }]];
  });
  const pool = makePool(connection);
  const { service, poolConfigs } = makeService({ pools: [pool] });

  const created = service.createConnectionPool({ host: '127.0.0.1', user: 'tester' });
  assert.equal(created, pool);
  assert.ok(poolConfigs[0].queueLimit > 0);
  assert.ok(poolConfigs[0].connectionLimit > 0);

  const state = { connectionConfig: { host: '127.0.0.1', user: 'tester' }, connectionPool: pool };
  const second = makeService({ state }).service;
  await second.listDatabases();
  assert.equal(seen[0].timeout, 4321);
});

test('failed connection replacement leaves the previous pool and config intact', async () => {
  const oldPool = makePool(makeConnection(async () => [[], []]));
  const failedPool = makePool(new Error('new database unavailable'));
  const oldConfig = { host: 'old-db', port: 3306, user: 'old-user' };
  const state = { connectionConfig: oldConfig, connectionPool: oldPool };
  const { service } = makeService({ state, pools: [failedPool] });

  await assert.rejects(
    service.replaceConnection({ host: 'new-db', port: 3306, user: 'new-user', password: 'secret' }),
    /unavailable/
  );
  assert.equal(state.connectionPool, oldPool);
  assert.equal(state.connectionConfig, oldConfig);
  assert.equal(oldPool.ended, false);
  assert.equal(failedPool.ended, true);
});

test('successful connection replacement publishes new state before retiring old pool', async () => {
  const oldPool = makePool(makeConnection(async () => [[], []]));
  const newConnection = makeConnection(async (options) => {
    const sql = typeof options === 'string' ? options : options.sql;
    if (/VERSION/i.test(sql)) {
      return [[{ version: '8.4.0' }], []];
    }
    if (/information_schema\.SCHEMATA/i.test(sql)) {
      return [[{ Database: 'analytics' }], []];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const newPool = makePool(newConnection);
  const state = {
    connectionConfig: { host: 'old-db', user: 'old-user' },
    connectionPool: oldPool
  };
  const { service } = makeService({ state, pools: [newPool] });

  const result = await service.replaceConnection({ host: 'new-db', port: 3306, user: 'new-user', password: 'secret' });
  assert.equal(result.version, '8.4.0');
  assert.deepEqual(result.databases, ['analytics']);
  assert.equal(state.connectionPool, newPool);
  assert.equal(state.connectionConfig.host, 'new-db');
  assert.equal(oldPool.ended, true);
});

test('template execution rejects client SQL before metadata or execution', async () => {
  const seenSql = [];
  const connection = makeConnection(async (options, params) => {
    const sql = typeof options === 'string' ? options : options.sql;
    seenSql.push({ sql, params, timeout: options.timeout });
    if (/information_schema\.TABLES/i.test(sql)) {
      return [[{ tableName: 'orders', tableComment: '订单' }], []];
    }
    if (/information_schema\.COLUMNS/i.test(sql)) {
      return [[
        { columnName: 'id', columnType: 'bigint', columnComment: '主键' },
        { columnName: 'created_at', columnType: 'datetime', columnComment: '创建时间' }
      ], []];
    }
    if (/COUNT\(1\)/i.test(sql)) {
      return [[{ 总行数: 3 }], [{ name: '总行数' }]];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const pool = makePool(connection);
  const state = {
    connectionConfig: { host: 'db', user: 'tester' },
    connectionPool: pool
  };
  const { service } = makeService({ state });

  await assert.rejects(service.executeTemplateQuery('analytics', {
    templateId: 'total-rows',
    table: 'orders',
    fields: {},
    sql: 'SELECT SLEEP(60)'
  }), /SQL|结构化|不接受/);
  assert.doesNotMatch(seenSql.map((entry) => entry.sql).join('\n'), /SLEEP/i);
});

test('region template fetches one sentinel row and reports truncation at 500 rows', async () => {
  const methods = [];
  const connection = makeConnection(async (options, params, method) => {
    const sql = typeof options === 'string' ? options : options.sql;
    methods.push({ sql, params, method });
    if (/information_schema\.TABLES/i.test(sql)) {
      return [[{ tableName: 'orders', tableComment: '订单' }], []];
    }
    if (/information_schema\.COLUMNS/i.test(sql)) {
      return [[{ columnName: 'region_name', columnType: 'varchar(64)', columnComment: '区域' }], []];
    }
    if (/SELECT DISTINCT/i.test(sql)) {
      return [Array.from({ length: 501 }, (_, index) => ({ region_name: `region-${index}` })), [{ name: 'region_name' }]];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const pool = makePool(connection);
  const state = { connectionConfig: { host: 'db', user: 'tester' }, connectionPool: pool };
  const { service } = makeService({ state });
  const response = await service.executeTemplateQuery('analytics', {
    templateId: 'region-distribution',
    table: 'orders',
    fields: { regionField: 'region_name' }
  });
  assert.equal(response.result.rows.length, 500);
  assert.equal(response.result.truncated, true);
  assert.equal(response.result.totalRowCount, 501);
  assert.equal(response.result.cellCharacterLimit, 512);
  assert.match(methods.find((entry) => /SELECT DISTINCT/i.test(entry.sql)).sql, /LEFT\(CAST\(`region_name` AS CHAR\),\s*512\)/i);
  assert.match(response.sql, /LIMIT 501/);
  assert.match(response.sql, /;$/);
  assert.ok(methods.filter((entry) => entry.params?.length).every((entry) => entry.method === 'execute'));
});

test('qualified identifiers preserve dots, backticks, and question marks without consuming value placeholders', async () => {
  const seen = [];
  const database = 'analytics.v2';
  const table = 'orders`?';
  const connection = makeConnection(async (options, params, method) => {
    const sql = typeof options === 'string' ? options : options.sql;
    seen.push({ sql, params, method });
    if (/information_schema\.TABLES/i.test(sql)) {
      return [[{ tableName: table, tableComment: '订单?' }], []];
    }
    if (/information_schema\.COLUMNS/i.test(sql)) {
      return [[{ columnName: 'id', columnType: 'bigint', columnComment: '主键' }], []];
    }
    if (/COUNT\(1\)/i.test(sql)) {
      return [[{ 总行数: 1 }], [{ name: '总行数' }]];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const state = { connectionConfig: { host: 'db', user: 'tester' }, connectionPool: makePool(connection) };
  const { service } = makeService({ state });
  const response = await service.executeTemplateQuery(database, {
    templateId: 'total-rows', table, fields: {}
  });

  const executed = seen.find((entry) => /COUNT\(1\)/i.test(entry.sql));
  assert.match(executed.sql, /FROM `analytics\.v2`\.`orders``\?`/);
  assert.match(response.sql, /FROM `analytics\.v2`\.`orders``\?`/);
  assert.equal((response.sql.match(/CONVERT\(0x/gi) || []).length, 1);
  assert.match(response.sql, /;$/);
});

test('all value parameters use prepared execute and display SQL is SQL-mode independent', async () => {
  const methods = [];
  const connection = makeConnection(async (options, params, method) => {
    const sql = typeof options === 'string' ? options : options.sql;
    methods.push({ sql, params, method });
    if (/information_schema\.TABLES/i.test(sql)) {
      return [[{ tableName: 'orders', tableComment: "O'Reilly 订单" }], []];
    }
    if (/information_schema\.COLUMNS/i.test(sql)) {
      return [[{ columnName: 'id', columnType: 'bigint', columnComment: '主键' }], []];
    }
    if (/COUNT\(1\)/i.test(sql)) {
      return [[{ 总行数: 3 }], [{ name: '总行数' }]];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const state = {
    connectionConfig: { host: 'db', user: 'tester', password: 'secret' },
    connectionPool: makePool(connection)
  };
  const { service } = makeService({ state });
  const response = await service.executeTemplateQuery('analytics', {
    templateId: 'total-rows', table: 'orders', fields: {}
  });

  assert.ok(methods.filter((entry) => entry.params?.length).every((entry) => entry.method === 'execute'));
  assert.match(response.sql, /CONVERT\(0x[0-9a-f]+ USING utf8mb4\)/i);
  assert.match(response.sql, /;$/);
  assert.doesNotMatch(response.sql, /O'Reilly/);
  assert.deepEqual(response.result.rows, [{ 总行数: 3 }]);
});

test('unhealthy status is truthful and does not expose stored credentials', async () => {
  const state = {
    connectionConfig: { host: 'db', port: 3306, user: 'tester', password: 'super-secret' },
    connectionPool: makePool(new Error('connection lost'))
  };
  const { service } = makeService({ state });
  const status = await service.getStatus();
  assert.equal(status.connected, false);
  assert.equal(status.health, 'unhealthy');
  assert.deepEqual(status.connection, { host: 'db', port: 3306, user: 'tester' });
  assert.doesNotMatch(JSON.stringify(status), /super-secret/);
});

test('table enumeration refuses metadata beyond its hard limit', async () => {
  const connection = makeConnection(async (options) => {
    const sql = typeof options === 'string' ? options : options.sql;
    if (/information_schema\.TABLES/i.test(sql)) {
      return [Array.from({ length: 1001 }, (_, index) => ({ tableName: `table_${index}` })), []];
    }
    if (/information_schema\.COLUMNS/i.test(sql)) {
      return [[], []];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const state = { connectionConfig: { host: 'db', user: 'tester' }, connectionPool: makePool(connection) };
  const { service } = makeService({ state });
  await assert.rejects(service.listTables('analytics'), (error) => error?.statusCode === 413);
});

test('table preview bounds rows, columns, and large cell payloads before buffering results', async () => {
  const seen = [];
  const connection = makeConnection(async (options, params, method) => {
    const sql = typeof options === 'string' ? options : options.sql;
    seen.push({ sql, params, method });
    if (/information_schema\.TABLES/i.test(sql)) {
      return [[{ tableName: 'documents', tableComment: '文档' }], []];
    }
    if (/information_schema\.COLUMNS/i.test(sql)) {
      return [[
        { columnName: 'id', columnType: 'bigint', columnComment: '主键' },
        { columnName: 'payload', columnType: 'longblob', columnComment: '二进制' },
        { columnName: 'notes', columnType: 'longtext', columnComment: '正文' },
        { columnName: 'shape?', columnType: 'point', columnComment: '坐标' },
        { columnName: 'area`shape', columnType: 'multipolygon', columnComment: '范围' },
        { columnName: 'embedding', columnType: 'vector(32)', columnComment: '向量' }
      ], []];
    }
    if (/^SELECT\s/i.test(sql)) {
      assert.doesNotMatch(sql, /SELECT\s+\*/i);
      assert.match(sql, /OCTET_LENGTH\(`payload`\)/i);
      assert.match(sql, /LEFT\(CAST\(`notes` AS CHAR\),\s*512\)/i);
      assert.match(sql, /OCTET_LENGTH\(`shape\?`\)/i);
      assert.match(sql, /OCTET_LENGTH\(`area``shape`\)/i);
      assert.match(sql, /OCTET_LENGTH\(`embedding`\)/i);
      assert.match(sql, /LIMIT\s+101$/i);
      return [[
        {
          id: '1', payload: '[binary 999999999 bytes]', notes: 'bounded',
          'shape?': '[binary 25 bytes]', 'area`shape': '[binary 90 bytes]', embedding: '[binary 128 bytes]'
        }
      ], [
        { name: 'id' }, { name: 'payload' }, { name: 'notes' },
        { name: 'shape?' }, { name: 'area`shape' }, { name: 'embedding' }
      ]];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const state = { connectionConfig: { host: 'db', user: 'tester' }, connectionPool: makePool(connection) };
  const { service } = makeService({ state });
  const result = await service.previewTable('analytics', 'documents', 500);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rowLimit, 100);
  assert.equal(result.returnedColumnCount, 6);
  assert.equal(result.totalColumnCount, 6);
  assert.equal(result.truncatedColumns, false);
  assert.equal(result.binaryValuesSummarized, true);
  assert.ok(seen.some((entry) => entry.method === 'execute' && entry.params?.length === 2));
});
