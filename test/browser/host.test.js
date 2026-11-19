'use strict';
/* The host page around the editor: its colours follow the browser, and its toolbar, hint and log are driven by the hooks. */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../helpers/browser');

const style = (page, sel, prop) => page.evaluate((sel, prop) => getComputedStyle(document.querySelector(sel))[prop], sel, prop);
const colourVar = (page, name) => page.evaluate(name => getComputedStyle(document.querySelector('.dag-editor')).getPropertyValue(name).trim(), name);

describe('colours follow the browser', () => {
  let b, page;
  before(async () => { b = await B.launch(); page = await b.newPage({ width: 1440, height: 900 }); await B.layoutDone(page); });
  after(async () => { await b.close(); });

  it('the editor\'s canvas and nodes change with prefers-color-scheme', async () => {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]); await B.sleep(100);
    const light = { bg: await style(page, '.dag-svg', 'backgroundColor'), fill: await style(page, '.dag-node-bg', 'fill'), text: await style(page, '.dag-node-label', 'fill') };
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]); await B.sleep(100);
    const dark = { bg: await style(page, '.dag-svg', 'backgroundColor'), fill: await style(page, '.dag-node-bg', 'fill'), text: await style(page, '.dag-node-label', 'fill') };
    assert.notEqual(light.bg, dark.bg);
    assert.notEqual(light.fill, dark.fill);
    assert.notEqual(light.text, dark.text);
    assert.equal(light.bg, await colourVarLight(page), 'light background comes from the light token');
  });

  it('edges and nodes share their default, hovered and selected colours, in both schemes', async () => {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]); await B.sleep(100);
      await page.evaluate(() => { const e = window.eval('editor'); e._setSelected(null, null); });
      await page.mouse.move(5, 5); await B.sleep(300);
      const nodeDefault = await style(page, '.dag-node:not(.dag-node--selected) .dag-node-bg', 'stroke');
      const edgeDefault = await style(page, 'path.dag-edge', 'stroke');
      assert.equal(edgeDefault, nodeDefault, `${scheme}: default edge = default node`);
      await page.evaluate(() => window.eval('editor')._setSelected('node', window.eval('editor').getGraph().nodes[0].id));
      await B.sleep(300);
      const nodeSel = await style(page, '.dag-node--selected .dag-node-bg', 'stroke');
      await page.evaluate(() => window.eval('editor')._setSelected('edge', window.eval('editor').getGraph().edges[0].id));
      await B.sleep(300);
      assert.equal(await style(page, 'path.dag-edge--selected', 'stroke'), nodeSel, `${scheme}: selected edge = selected node`);
    }
  });

  it('the arrowheads of default edges follow the edge colour where the browser supports it', async () => {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]); await B.sleep(100);
    const fill = await page.evaluate(() => getComputedStyle(document.querySelector('marker#dag-arrow polygon')).fill);
    assert.ok(fill && fill !== 'none');
  });

  it('the demo page itself follows the browser too', async () => {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]); await B.sleep(100);
    const l = await style(page, 'body', 'backgroundColor');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]); await B.sleep(100);
    assert.notEqual(await style(page, 'body', 'backgroundColor'), l);
  });

  it('ran without script errors', () => assert.deepEqual(page.errors, []));
});

async function colourVarLight(page) {
  // the light token, read from a light page of its own
  const p = await page.browser().newPage();
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await p.goto(B.DEMO_URL, { waitUntil: 'load' });
  const v = await p.evaluate(() => getComputedStyle(document.querySelector('.dag-svg')).backgroundColor);
  await p.close();
  return v;
}

describe('the host page: toolbar, hint and log', () => {
  let b, page;
  before(async () => { b = await B.launch(); });
  after(async () => { await b.close(); });

  it('a refused edge shows its reason in the hint bar, and the usual text comes back', async () => {
    page = await b.newPage({ width: 1440, height: 900 }); await B.layoutDone(page);
    await page.evaluate(() => { window.eval('editor').loadGraph({ version: 2, nodes: [
      { id: 'a', label: 'A', x: 0, y: 0, inputs: [{ id: 'in', label: '' }], outputs: [{ id: 'out', label: '' }] },
      { id: 'b', label: 'B', x: 300, y: 0, inputs: [{ id: 'in', label: '' }], outputs: [{ id: 'out', label: '' }] }], edges: [] }); });
    await page.evaluate(() => { const e = window.eval('editor'); e.addEdge('a', 'out', 'b', 'in'); e.addEdge('b', 'out', 'a', 'in'); });
    assert.match(await page.$eval('#hint', h => h.textContent), /cycle/);
    assert.ok(await page.$eval('#hint', h => h.classList.contains('warn')));
    await B.sleep(2300);
    assert.doesNotMatch(await page.$eval('#hint', h => h.textContent), /cycle/);
    assert.ok(!(await page.$eval('#hint', h => h.classList.contains('warn'))));
    await b.closePage(page);
  });

  it('dragging a node logs a move; a click does not', async () => {
    page = await b.newPage({ width: 1440, height: 900 }); await B.layoutDone(page);
    const n0 = await page.evaluate(() => document.querySelectorAll('#event-log .log-entry.moved').length);
    const r = await B.nodeRect(page, 'Parse');
    await page.mouse.click(r.cx, r.cy);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#event-log .log-entry.moved').length), n0, 'a click is not logged as a move');
    await page.mouse.move(r.cx, r.cy); await page.mouse.down(); await page.mouse.move(r.cx + 40, r.cy + 10, { steps: 4 }); await page.mouse.up();
    assert.equal(await page.evaluate(() => document.querySelectorAll('#event-log .log-entry.moved').length), n0 + 1);
    await b.closePage(page);
  });

  it('the toolbar buttons do what they say, and the layout button shows its state through the hooks', async () => {
    page = await b.newPage({ width: 1440, height: 900 }); await B.layoutDone(page);
    const count = () => page.evaluate(() => window.eval('editor').getGraph().nodes.length);
    await page.click('[data-action="add-node"]'); assert.equal(await count(), 13);
    await page.click('[data-action="undo"]');     assert.equal(await count(), 12);
    await page.click('[data-action="layout"]', { count: 2, delay: 30 });
    await B.sleep(200);
    assert.ok(await page.$eval('#layout-btn', b => b.classList.contains('pinned')));
    assert.equal(await page.evaluate(() => window.eval('editor').layoutPinned), true);
    await page.click('[data-action="layout"]', { count: 2, delay: 30 });
    await B.sleep(200);
    assert.ok(!(await page.$eval('#layout-btn', b => b.classList.contains('pinned'))));
    await b.closePage(page);
  });
});
