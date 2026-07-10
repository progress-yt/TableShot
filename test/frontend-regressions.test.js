const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = join(__dirname, '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

test('query requests use template metadata and never submit client-generated SQL', () => {
  const source = read('public/app.js');
  const core = read('public/app-core.js');
  assert.doesNotMatch(source, /body:\s*JSON\.stringify\(\{[\s\S]{0,500}?\bsql\s*,/);
  assert.match(source, /JSON\.stringify\(buildQueryRequest\(\{/);
  assert.match(core, /function buildQueryRequest/);
  assert.match(core, /const fields = \{\}/);
});

test('preview mode blocks the real API adapter at its boundary', () => {
  const source = read('public/app.js');
  assert.match(source, /function api[\s\S]{0,300}?PREVIEW_MODE[\s\S]{0,200}?throw/);
});

test('table and table-detail requests have abortable request generations', () => {
  const source = read('public/app.js');
  assert.match(source, /selectionRequests/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /isCurrent\(/);
});

test('capture success requires an artifact and output folder comes from the artifact', () => {
  const source = read('public/app.js');
  assert.match(source, /requireCaptureArtifact/);
  assert.match(source, /artifact\.folderPath/);
  assert.doesNotMatch(source, /path:\s*`captures\/\$\{state\.runContext\.folderName\}`/);
});

test('preview and capture completeness use server truncation metadata without claiming a sentinel as an exact total', () => {
  const source = read('public/app.js');
  const core = read('public/app-core.js');
  assert.match(source, /describePreviewCompleteness\(state\.preview\)/);
  assert.match(source, /describeCaptureCompleteness\(artifact\)/);
  assert.match(core, /queryTruncated/);
  assert.match(core, /returnedRowCount/);
  assert.doesNotMatch(source, /message:[^\n]*artifact\.totalRowCount/);
});

test('app and login expose explicit run locks', () => {
  const app = read('public/app.js');
  const login = read('public/login.js');
  assert.match(app, /singleRunLock/);
  assert.match(app, /batchRunLock/);
  assert.match(login, /connectLock/);
});

test('dialog, toggle, progress, and live-region semantics are present', () => {
  const html = read('public/index.html');
  assert.match(html, /id="batchConfirmModal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="batchProgressBar"[^>]*role="progressbar"/);
  assert.match(html, /id="batchProgressText"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /<button id="status(?:Connection|Selection|Browser|Output)"/);
});

test('reduced motion and visible keyboard focus are supported', () => {
  const styles = `${read('public/styles.css')}\n${read('public/login.css')}`;
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  assert.match(styles, /:focus-visible[\s\S]{0,160}?outline:/);
});

test('shared frontend core is loaded before the application', () => {
  const html = read('public/index.html');
  assert.match(html, /<script src="\/app-core\.js[^>]*><\/script>[\s\S]*<script src="\/app\.js/);
});

test('task generation indexes existing tasks instead of scanning inside the cartesian loop', () => {
  const source = read('public/app.js');
  const start = source.indexOf('function saveCurrentTask()');
  const end = source.indexOf('async function prewarmCaptureSessions', start);
  const implementation = source.slice(start, end);
  assert.match(implementation, /const tasksByKey = new Map/);
  assert.doesNotMatch(implementation, /state\.tasks\.find\(/);
});

test('analyze confirmation is driven by server template side-effect metadata', () => {
  const source = read('public/app.js');
  assert.match(source, /sideEffects\.includes\('analyze-table'\)/);
  assert.doesNotMatch(source, /templateId === 'storage-usage'/);
  assert.match(source, /confirm:\s*true/);
});
