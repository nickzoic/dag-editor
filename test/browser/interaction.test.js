'use strict';
/* Pointer, keyboard, wheel, CSS states and text measurement, in a real browser. */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../helpers/browser');

const near = (a, b, tol = 1.5) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const ed = (page, fn, ...args) => page.evaluate(fn, ...args);
const counts = page => page.evaluate(() => { const e = window.eval('editor'); return { nodes: e.getGraph().nodes.length, edges: e.getGraph().edges.length, sel: e._selected && e._selected.id }; });
const style = (page, sel, prop) => page.evaluate((sel, prop) => getComputedStyle(document.querySelector(sel))[prop], sel, prop);
const nodeSel = id => `.dag-node[data-id="${id}"]`;

describe('real input devices', () => {
  let b, page;
  before(async () => { b = await B.launch(); });
  after(async () => { await b.close(); });
  beforeEach(async () => {
    if (page) await b.closePage(page);
    page = await b.newPage({ width: 1440, height: 900 });
    await B.layoutDone(page);
    await ed(page, () => { const e = window.eval('editor'); e.loadGraph({ version: 2, nodes: [
      { id: 'a', label: 'A', x: 60, y: 60, inputs: [{ id: 'in', label: '' }], outputs: [{ id: 'out', label: '' }] },
      { id: 'b', label: 'B', x: 360, y: 60, inputs: [{ id: 'in', label: '' }], outputs: [{ id: 'out', label: '' }] },
      { id: 'c', label: 'C', x: 360, y: 220, inputs: [{ id: 'in', label: '' }], outputs: [] }], edges: [] }); });
  });

  it('a click on empty canvas creates a node centred on the click', async () => {
    const c = await B.canvasRect(page), x = c.x + c.w - 80, y = c.y + c.h - 60;
    await page.mouse.click(x, y);
    const n = await ed(page, () => window.eval('editor').getGraph().nodes.at(-1).label);
    const r = await B.nodeRect(page, n);
    near(r.cx, x, 2); near(r.cy, y, 2);
    assert.equal((await counts(page)).nodes, 4);
  });

  it('dragging a node moves it, and undo puts it back', async () => {
    const r0 = await B.nodeRect(page, 'A'), j0 = await ed(page, () => window.eval('editor').getGraph().nodes[0].x);
    await page.mouse.move(r0.cx, r0.cy); await page.mouse.down(); await page.mouse.move(r0.cx + 90, r0.cy + 40, { steps: 6 }); await page.mouse.up();
    const r1 = await B.nodeRect(page, 'A');
    near(r1.cx - r0.cx, 90); near(r1.cy - r0.cy, 40);
    await page.keyboard.press('z', { ctrlKey: true }).catch(() => {});
    await ed(page, () => window.eval('editor').undo());
    near(await ed(page, () => window.eval('editor').getGraph().nodes[0].x), j0, 0.001);
  });

  it('drawing an edge shows a draft line, lights the target port, and connects on release', async () => {
    const from = await B.portCentre(page, 'A', 'out', 'out'), to = await B.portCentre(page, 'B', 'in', 'in');
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    assert.equal(await ed(page, () => document.querySelector('.dag-edge-draft').style.display !== 'none'), true);
    assert.equal(await ed(page, sel => document.querySelector(sel).classList.contains('dag-port--target'), `${nodeSel('b')} circle[data-port-uid="in:in"]`), true);
    await page.mouse.up();
    assert.equal((await counts(page)).edges, 1);
    assert.equal(await ed(page, () => document.querySelector('.dag-edge-draft').style.display), 'none');
  });

  it('dropping an edge on a node body connects to its input; on empty canvas it makes a new node', async () => {
    const from = await B.portCentre(page, 'A', 'out', 'out'), body = await B.nodeRect(page, 'C');
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(body.cx, body.cy, { steps: 6 }); await page.mouse.up();
    assert.equal((await counts(page)).edges, 1);
    const c = await B.canvasRect(page);
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(c.x + c.w - 100, c.y + c.h - 100, { steps: 6 }); await page.mouse.up();
    assert.deepEqual(await counts(page), { nodes: 4, edges: 2, sel: await ed(page, () => window.eval('editor').getGraph().nodes.at(-1).id) });
  });

  it('refuses a cycle and says so in the hint bar', async () => {
    await ed(page, () => window.eval('editor').addEdge('a', 'out', 'b', 'in'));
    const from = await B.portCentre(page, 'B', 'out', 'out'), to = await B.portCentre(page, 'A', 'in', 'in');
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up();
    assert.equal((await counts(page)).edges, 1);
    assert.match(await ed(page, () => document.getElementById('hint').textContent), /cycle/);
  });

  it('clicking an edge selects it; Delete removes it', async () => {
    await ed(page, () => window.eval('editor').addEdge('a', 'out', 'b', 'in'));
    const mid = await ed(page, () => { const e = window.eval('editor'), x = e.getGraph().edges[0], m = e._bezierAt(e._edgeP1(x), e._edgeP2(x), 0.5), r = document.querySelector('.dag-svg').getBoundingClientRect();
      return { x: r.x + e._viewX + m.x * e._scale, y: r.y + e._viewY + m.y * e._scale }; });
    await page.mouse.click(mid.x, mid.y);
    assert.equal((await counts(page)).sel, 'e1');
    await page.keyboard.press('Delete');
    assert.equal((await counts(page)).edges, 0);
  });

  describe('keyboard shortcuts', () => {
    beforeEach(async () => { await ed(page, () => window.eval('editor')._container.focus()); });

    it('N makes a node, Delete / Backspace remove the selection', async () => {
      await page.keyboard.press('n');
      assert.equal((await counts(page)).nodes, 4);
      await page.keyboard.press('Delete');
      assert.equal((await counts(page)).nodes, 3);
      await page.keyboard.press('Tab'); await page.keyboard.press('Backspace');
      assert.equal((await counts(page)).nodes, 2);
    });

    it('Tab and Shift+Tab move the selection; Escape clears it', async () => {
      await page.keyboard.press('Tab'); assert.equal((await counts(page)).sel, 'a');
      await page.keyboard.press('Tab'); assert.equal((await counts(page)).sel, 'b');
      await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
      assert.equal((await counts(page)).sel, 'a');
      await page.keyboard.press('Escape');
      assert.equal((await counts(page)).sel, null);
    });

    it('Ctrl+Z and Ctrl+Shift+Z undo and redo', async () => {
      await page.keyboard.press('n'); await page.keyboard.press('n');
      assert.equal((await counts(page)).nodes, 5);
      await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
      assert.equal((await counts(page)).nodes, 4);
      await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
      assert.equal((await counts(page)).nodes, 5);
    });

    it('L runs a layout, and Shift+L pins and unpins it', async () => {
      await page.keyboard.down('Shift'); await page.keyboard.press('L'); await page.keyboard.up('Shift');
      assert.equal(await ed(page, () => window.eval('editor')._layoutPinned), true);
      assert.ok(await ed(page, () => document.getElementById('layout-btn').classList.contains('pinned')));
      await page.keyboard.down('Shift'); await page.keyboard.press('L'); await page.keyboard.up('Shift');
      assert.equal(await ed(page, () => window.eval('editor')._layoutPinned), false);
    });
  });

  describe('the view', () => {
    it('the wheel zooms about the pointer', async () => {
      const c = await B.canvasRect(page), x = c.x + c.w / 2, y = c.y + c.h / 2, s0 = (await B.editorState(page)).scale;
      const before = await ed(page, (x, y) => window.eval('editor')._clientToGraph(x, y), x, y);
      await page.mouse.move(x, y); await page.mouse.wheel({ deltaY: -200 });
      await B.sleep(100);
      const s1 = (await B.editorState(page)).scale, after = await ed(page, (x, y) => window.eval('editor')._clientToGraph(x, y), x, y);
      assert.ok(s1 > s0);
      near(after.x, before.x, 1); near(after.y, before.y, 1);          // wheel coordinates are whole pixels
      await page.mouse.wheel({ deltaY: 400 }); await B.sleep(100);
      assert.ok((await B.editorState(page)).scale < s1);
    });

    it('Alt + drag pans without creating a node', async () => {
      const c = await B.canvasRect(page), v0 = await ed(page, () => { const e = window.eval('editor'); return [e._viewX, e._viewY]; });
      await page.keyboard.down('Alt');
      await page.mouse.move(c.x + c.w - 120, c.y + c.h - 80); await page.mouse.down(); await page.mouse.move(c.x + c.w - 70, c.y + c.h - 110, { steps: 4 }); await page.mouse.up();
      await page.keyboard.up('Alt');
      const v1 = await ed(page, () => { const e = window.eval('editor'); return [e._viewX, e._viewY]; });
      near(v1[0] - v0[0], 50, 0.5); near(v1[1] - v0[1], -30, 0.5);
      assert.equal((await counts(page)).nodes, 3);
    });

    it('Fit brings the whole graph back into view', async () => {
      await page.mouse.move(700, 400); await page.mouse.wheel({ deltaY: -1500 });
      await page.click('[data-action="fit"]');
      assert.ok(await B.allNodesInside(page));
    });
  });

  describe('toolbar', () => {
    it('+ Node, Delete, Undo and Redo work', async () => {
      await page.click('[data-action="add-node"]');
      assert.equal((await counts(page)).nodes, 4);
      await page.click('[data-action="undo"]');
      assert.equal((await counts(page)).nodes, 3);
      await page.click('[data-action="redo"]');
      assert.equal((await counts(page)).nodes, 4);
      await page.click('[data-action="del-selected"]');
      assert.equal((await counts(page)).nodes, 4, 'undo and redo clear the selection, so there is nothing to delete');
      await ed(page, () => window.eval('editor')._setSelected('node', 'a'));
      await page.click('[data-action="del-selected"]');
      assert.equal((await counts(page)).nodes, 3);
    });

    it('Layout lights up while it runs, and a double-click pins it', async () => {
      await ed(page, () => { window.eval('editor').getGraph().nodes[0].y += 300; });
      await page.click('[data-action="layout"]');
      assert.ok(await ed(page, () => document.getElementById('layout-btn').classList.contains('on')));
      await B.layoutDone(page);
      await B.sleep(100);
      assert.ok(!(await ed(page, () => document.getElementById('layout-btn').classList.contains('on'))), 'off again once the run has finished');
      await page.click('#layout-btn', { count: 2, delay: 30 });
      await B.sleep(300);
      assert.equal(await ed(page, () => window.eval('editor').layoutPinned), true);
      assert.ok(await ed(page, () => document.getElementById('layout-btn').classList.contains('pinned')));
    });
  });

  describe('how it looks (CSS)', () => {
    // The colours follow the browser's light / dark setting; these checks hold in either scheme.
    it('hovering a node brightens its outline and shows its port rings', async () => {
      const rest = await style(page, `${nodeSel('b')} .dag-node-bg`, 'stroke'), portRest = await style(page, `${nodeSel('b')} .dag-port`, 'stroke');
      await page.hover(`${nodeSel('b')} .dag-node-bg`); await B.sleep(350);
      assert.notEqual(await style(page, `${nodeSel('b')} .dag-node-bg`, 'stroke'), rest);
      assert.notEqual(await style(page, `${nodeSel('b')} .dag-port`, 'stroke'), portRest);
    });

    it('a selected node has the selected outline, its ports match, and it keeps it when hovered', async () => {
      await ed(page, () => window.eval('editor')._setSelected('node', 'b'));
      await page.mouse.move(5, 5); await B.sleep(350);
      const sel = await style(page, `${nodeSel('b')} .dag-node-bg`, 'stroke');
      assert.equal(await style(page, `${nodeSel('b')} .dag-port`, 'stroke'), sel);
      await page.hover(`${nodeSel('b')} .dag-node-bg`); await B.sleep(350);
      assert.equal(await style(page, `${nodeSel('b')} .dag-node-bg`, 'stroke'), sel);
    });

    it('a selected edge has the same selected colour as a selected node, and keeps it when hovered', async () => {
      await ed(page, () => { const e = window.eval('editor'); e.addEdge('a', 'out', 'b', 'in'); e._setSelected('node', 'b'); });
      await page.mouse.move(5, 5); await B.sleep(350);
      const selectedNode = await style(page, `${nodeSel('b')} .dag-node-bg`, 'stroke');
      await ed(page, () => window.eval('editor')._setSelected('edge', 'e1'));
      await B.sleep(350);
      assert.equal(await style(page, 'path.dag-edge[data-id="e1"]', 'stroke'), selectedNode);
      const m = await ed(page, () => { const e = window.eval('editor'), x = e.getGraph().edges[0], p = e._bezierAt(e._edgeP1(x), e._edgeP2(x), 0.5), r = document.querySelector('.dag-svg').getBoundingClientRect();
        return { x: r.x + e._viewX + p.x * e._scale, y: r.y + e._viewY + p.y * e._scale }; });
      await page.mouse.move(m.x, m.y); await B.sleep(350);
      assert.equal(await style(page, 'path.dag-edge[data-id="e1"]', 'stroke'), selectedNode);
    });

    it('an edge has the same default and hovered colours as a node', async () => {
      await ed(page, () => window.eval('editor').addEdge('a', 'out', 'b', 'in'));
      await page.mouse.move(5, 5); await B.sleep(350);
      const nodeRest = await style(page, `${nodeSel('c')} .dag-node-bg`, 'stroke');
      const edgeRest = await style(page, 'path.dag-edge[data-id="e1"]', 'stroke');
      assert.equal(edgeRest, nodeRest, 'default edges use the default node outline colour');
      await page.hover(`${nodeSel('c')} .dag-node-bg`); await B.sleep(350);
      const nodeHover = await style(page, `${nodeSel('c')} .dag-node-bg`, 'stroke');
      assert.notEqual(nodeHover, nodeRest);
      const m = await ed(page, () => { const e = window.eval('editor'), x = e.getGraph().edges[0], p = e._bezierAt(e._edgeP1(x), e._edgeP2(x), 0.5), r = document.querySelector('.dag-svg').getBoundingClientRect();
        return { x: r.x + e._viewX + p.x * e._scale, y: r.y + e._viewY + p.y * e._scale }; });
      await page.mouse.move(m.x, m.y); await B.sleep(350);
      assert.equal(await style(page, 'path.dag-edge[data-id="e1"]', 'stroke'), nodeHover, 'hovered edges use the hovered node colour');
    });

    it('ports always have a visible border', async () => {
      const stroke = await style(page, `${nodeSel('a')} .dag-port`, 'stroke');
      assert.notEqual(stroke, 'none'); assert.notEqual(stroke, 'rgba(0, 0, 0, 0)');
    });

    it('edges are drawn on top of nodes', async () => {
      const order = await ed(page, () => { const kids = [...document.querySelector('.dag-svg').children]; return [kids.indexOf(document.querySelector('.dag-svg > g:has(.dag-node)')), kids.findIndex(k => k.tagName === 'g' && k.querySelector('.dag-edge-draft'))]; });
      assert.ok(order[0] >= 0 && order[1] > order[0], 'the edge layer comes after the node layer');
    });
  });

  it('ran without script errors', () => assert.deepEqual(page.errors, []));
});

describe('text measured by the browser', () => {
  let b, page;
  before(async () => { b = await B.launch(); page = await b.newPage({ width: 1440, height: 900 }); await B.layoutDone(page); });
  after(async () => { await b.close(); });

  it('uses real text widths, not the 7.2 px-a-character estimate', async () => {
    const r = await ed(page, () => { const e = window.eval('editor'); return { real: e._textWidth('Customers'), est: 'Customers'.length * 7.2, port: e._portTextWidth('enriched'), portEst: 'enriched'.length * 5.8 }; });
    assert.ok(r.real > 0 && Math.abs(r.real - r.est) > 0.5, `measured ${r.real}, estimate ${r.est}`);
    assert.ok(r.port > 0);
  });

  it('wraps a long label so every line really fits, in both layouts', async () => {
    for (const [w, h, max] of [[1440, 900, 98], [760, 900, 100]]) {
      await B.resize(page, w, h);
      const widths = await ed(page, () => {
        const e = window.eval('editor'); e.loadGraph({ version: 2, nodes: [
          { id: 'x', label: 'a rather long node label that has to wrap onto several lines', x: 0, y: 0, inputs: [{ id: 'i', label: '' }], outputs: [{ id: 'o', label: '' }] },
          { id: 'y', label: 'Supercalifragilisticexpialidocious', x: 300, y: 0, inputs: [{ id: 'i', label: '' }], outputs: [] }], edges: [] });
        return [...document.querySelectorAll('.dag-node-label tspan')].map(t => t.getComputedTextLength()); });
      assert.ok(widths.length > 4, 'the labels wrapped onto several lines');
      assert.ok(widths.every(x => x <= max + 1), `every line fits within ${max}px (widest ${Math.max(...widths).toFixed(1)})`);
    }
  });

  it('a wrapped node is taller on screen, and no wrapped line pokes out of its node', async () => {
    await B.resize(page, 1440, 900);
    await ed(page, () => window.eval('editor').loadGraph({ version: 2, nodes: [
      { id: 's', label: 'Short', x: 0, y: 0, inputs: [], outputs: [] },
      { id: 'l', label: 'a rather long node label that has to wrap onto several lines', x: 300, y: 0, inputs: [], outputs: [] }], edges: [] }));
    const sh = await B.nodeRect(page, 'Short'), lg = await ed(page, () => { const g = [...document.querySelectorAll('.dag-node')][1], r = g.querySelector('.dag-node-bg').getBoundingClientRect();
      const lines = [...g.querySelectorAll('.dag-node-label tspan')].map(t => t.getBoundingClientRect()); return { h: r.height, inside: lines.every(l => l.top >= r.top - 1 && l.bottom <= r.bottom + 1 && l.left >= r.left - 1 && l.right <= r.right + 1) }; });
    assert.ok(lg.h > sh.h * 1.5);
    assert.ok(lg.inside);
  });

  it('with real widths, flipped ports widen a node just enough for the widest label', async () => {
    await B.resize(page, 760, 900);
    const r = await ed(page, () => { const e = window.eval('editor'); e.loadGraph({ version: 2, nodes: [{ id: 'n', label: 'N', x: 0, y: 0,
      inputs: [{ id: 'a', label: 'validation_result' }, { id: 'b', label: 'ok' }, { id: 'c', label: '' }], outputs: [] }], edges: [] });
      const g = e._flipGeom(e.getGraph().nodes[0]); return { w: g.w, gap: g.inX[1] - g.inX[0], widest: e._portTextWidth('validation_result') }; });
    assert.ok(r.gap >= r.widest + 10 - 1e-6);
    assert.ok(r.w > 120);
  });

  it('ran without script errors', () => assert.deepEqual(page.errors, []));
});

describe('layout in a real browser', () => {
  let b;
  before(async () => { b = await B.launch(); });
  after(async () => { await b.close(); });

  for (const [name, w, h] of [['landscape', 1440, 900], ['portrait', 760, 1100]]) {
    it(`no two nodes overlap on screen after the start-up layout (${name})`, async () => {
      const page = await b.newPage({ width: w, height: h });
      await B.layoutDone(page); await B.sleep(200);
      const overlaps = await ed(page, () => { const rs = [...document.querySelectorAll('.dag-node-bg')].map(r => r.getBoundingClientRect()); let c = 0;
        for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const a = rs[i], d = rs[j]; if (a.left < d.right && d.left < a.right && a.top < d.bottom && d.top < a.bottom) c++; } return c; });
      assert.equal(overlaps, 0);
      assert.equal((await B.editorState(page)).nodes, 12);
      await b.closePage(page);
    });
  }

  it('the layout of the demo graph is the same every time it is opened', async () => {
    const jsons = [];
    for (let i = 0; i < 2; i++) { const page = await b.newPage({ width: 1440, height: 900 }); await B.layoutDone(page); jsons.push((await B.editorState(page)).json); await b.closePage(page); }
    assert.equal(jsons[0], jsons[1]);
  });
});
