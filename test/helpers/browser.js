'use strict';
/*
 * Helpers for the browser integration tests: drives a real Chrome/Chromium through puppeteer-core.
 *
 *   CHROME_PATH            path to a Chrome / Chromium binary (otherwise common locations are tried)
 *   PUPPETEER_HEADLESS     'shell' for chrome-headless-shell builds; default is Chrome's headless mode
 *   HEADED=1               show the browser window
 *
 * When NODE_V8_COVERAGE is set (the `c8` wrapper does this) the browser's own V8 coverage of
 * dag-editor.js is written there, to be merged with the unit-test coverage.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..');
const DEMO_URL = pathToFileURL(path.join(ROOT, 'dag-editor-demo.html')).href;

function findChrome() {
  const fromEnv = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) throw new Error(`CHROME_PATH does not exist: ${fromEnv}`);
    return fromEnv;
  }
  const candidates = [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium', '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) {
    throw new Error('No Chrome/Chromium found for the browser tests. Install one, or set CHROME_PATH to its location.');
  }
  return found;
}

/** True if a browser can be found (lets callers skip rather than fail, if they want to). */
function chromeAvailable() { try { findChrome(); return true; } catch { return false; } }

let seq = 0;

/** Launch a browser. Returns { newPage, closePage, close }. */
async function launch() {
  const headless = process.env.HEADED ? false : (process.env.PUPPETEER_HEADLESS === 'shell' ? 'shell' : true);
  const browser = await puppeteer.launch({
    executablePath: findChrome(), headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'],
  });
  const covDir = process.env.NODE_V8_COVERAGE;
  const open = new Set();
  const raw = [];                                   // raw V8 coverage of dag-editor.js, from every page

  async function collect(page) {
    if (!covDir) return;
    try {
      const entries = await page.coverage.stopJSCoverage();
      for (const e of entries) if (e.rawScriptCoverage && /\/dag-editor\.js$/.test(e.url)) raw.push(e.rawScriptCoverage);
    } catch { /* the page may already be gone */ }
  }

  return {
    browser,
    /** Open a page on `url` (default: the demo) at the given viewport size. `page.errors` collects script errors. */
    async newPage({ width = 1440, height = 900, url = DEMO_URL, settle = 0 } = {}) {
      const page = await browser.newPage();
      page.errors = [];
      page.on('pageerror', e => page.errors.push(`pageerror: ${e.message}`));
      page.on('console', m => { if (m.type() === 'error') page.errors.push(`console: ${m.text()}`); });
      await page.setViewport({ width, height });
      if (covDir) await page.coverage.startJSCoverage({ resetOnNavigation: false, includeRawScriptCoverage: true });
      await page.goto(url, { waitUntil: 'load' });
      if (settle) await sleep(settle);
      open.add(page);
      return page;
    },
    async closePage(page) { open.delete(page); await collect(page); await page.close(); },
    async close() {
      for (const page of [...open]) { open.delete(page); await collect(page); }
      if (covDir && raw.length) {
        fs.mkdirSync(covDir, { recursive: true });
        fs.writeFileSync(path.join(covDir, `coverage-${process.pid}-${Date.now()}-${seq++}-browser.json`), JSON.stringify({ result: raw }));
      }
      await browser.close();
    },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- small helpers used by several browser test files ---- */

/** Wait until the editor has finished any auto-layout animation. */
async function layoutDone(page, timeout = 5000) {
  await page.waitForFunction(() => window.eval('editor') && !window.eval('editor')._layoutActive, { timeout });
}

/** The editor instance's state, as plain data. */
const editorState = page => page.evaluate(() => {
  const e = window.eval('editor');
  return { flipped: e.flipped, scale: e._scale, active: e._layoutActive, json: JSON.stringify(e.toJSON()),
           nodes: e.getGraph().nodes.length, edges: e.getGraph().edges.length };
});

/** Screen rectangle of a node's box, found by its label text. */
const nodeRect = (page, label) => page.evaluate(label => {
  for (const g of document.querySelectorAll('.dag-node')) {
    if ([...g.querySelectorAll('.dag-node-label tspan')].map(t => t.textContent).join(' ') === label) {
      const r = g.querySelector('.dag-node-bg').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }
  }
  return null;
}, label);

/** Screen centre of a port dot of the node with this label. dir: 'in' | 'out' */
const portCentre = (page, label, dir, id) => page.evaluate((label, dir, id) => {
  for (const g of document.querySelectorAll('.dag-node')) {
    if ([...g.querySelectorAll('.dag-node-label tspan')].map(t => t.textContent).join(' ') === label) {
      const c = g.querySelector(`circle[data-port-uid="${id}:${dir}"]`);
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
  }
  return null;
}, label, dir, id);

/** True if every node box lies inside the editor's canvas. */
const allNodesInside = page => page.evaluate(() => {
  const s = document.querySelector('.dag-svg').getBoundingClientRect();
  return [...document.querySelectorAll('.dag-node-bg')].every(r => {
    const b = r.getBoundingClientRect();
    return b.left >= s.left - 1 && b.right <= s.right + 1 && b.top >= s.top - 1 && b.bottom <= s.bottom + 1;
  });
});

/** The canvas (svg) rectangle in client coordinates. */
const canvasRect = page => page.evaluate(() => {
  const r = document.querySelector('.dag-svg').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});

/** Resize the viewport and give the ResizeObserver a moment. */
async function resize(page, width, height) { await page.setViewport({ width, height }); await sleep(450); }

module.exports = { launch, chromeAvailable, findChrome, sleep, layoutDone, editorState, nodeRect, portCentre,
                   allNodesInside, canvasRect, resize, DEMO_URL, ROOT };
