const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'captures',
  'logs',
  'node_modules',
  'tmp'
]);

function collectJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return IGNORED_DIRECTORIES.has(entry.name)
        ? []
        : collectJavaScriptFiles(path.join(directory, entry.name));
    }
    return entry.isFile() && entry.name.endsWith('.js')
      ? [path.join(directory, entry.name)]
      : [];
  });
}

const files = collectJavaScriptFiles(ROOT_DIR).sort();
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: ROOT_DIR,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`Syntax check passed for ${files.length} JavaScript files.`);
}
