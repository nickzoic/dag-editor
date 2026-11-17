#!/usr/bin/env node
'use strict';
/*
 * Runs the tests with Node's built-in test runner.
 *
 *   node test/run.js unit      jsdom unit tests
 *   node test/run.js browser   integration tests in a real Chrome / Chromium
 *   node test/run.js all       both (the default)
 *
 * Any further arguments are passed to `node --test`, e.g. --test-name-pattern="flip".
 * Listing the files here (rather than leaving it to a glob) keeps this working on every Node and OS.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [, , kind = 'all', ...extra] = process.argv;
const kinds = { unit: ['unit'], browser: ['browser'], all: ['unit', 'browser'] };
if (!kinds[kind]) {
  console.error(`usage: node test/run.js [unit|browser|all] [node --test options]`);
  process.exit(2);
}

let status = 0;
for (const dir of kinds[kind]) {
  const folder = path.join(__dirname, dir);
  const files = fs.readdirSync(folder).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(folder, f));
  console.log(`\n=== ${dir} tests (${files.length} files) ===`);
  // Browser tests share one machine's CPU and a display-less browser: run them one file at a time.
  const concurrency = dir === 'browser' ? ['--test-concurrency=1'] : [];
  const r = spawnSync(process.execPath, ['--test', ...concurrency, ...extra, ...files], { stdio: 'inherit' });
  if (r.status !== 0) status = r.status || 1;
}
process.exit(status);
