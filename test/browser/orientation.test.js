'use strict';
/* Orientation, resizing and fitting, driven in a real browser. */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../helpers/browser');

const near = (a, b, tol = 1.5) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const model = page => page.evaluate(() => window.eval('editor').getGraph().nodes.map(n => ({ id: n.id, label: n.label, x: n.x, y: n.y })));
const nodeCount = page => page.evaluate(() => window.eval('editor').getGraph().nodes.length);
const edgeCount = page => page.evaluate(() => window.eval('editor').getGraph().edges.length);

describe('orientation and resizing (real browser)', () => {
  let b, page;
  before(async () => { b = await B.launch(); page = await b.newPage({ width: 1440, height: 900 }); await B.layoutDone(page); });
  after(async () => { await b.close(); });

  it('opens unflipped, with the whole graph fitted inside the canvas', async () => {
    assert.equal((await B.editorState(page)).flipped, false);
    assert.ok(await B.allNodesInside(page));
  });

  describe('after the window becomes tall and narrow', () => {
    let exportedBefore;
    before(async () => { exportedBefore = (await B.editorState(page)).json; await B.resize(page, 760, 900); });

    it('the graph is flipped, but the exported positions are exactly as they were', async () => {
      const s = await B.editorState(page);
      assert.equal(s.flipped, true);
      assert.equal(s.json, exportedBefore);
    });

    it('and is re-fitted to the new size', async () => assert.ok(await B.allNodesInside(page)));

    it('every node is drawn at the transposed position of its unflipped centre', async () => {
      const ok = await page.evaluate(() => { const e = window.eval('editor');
        return e.getGraph().nodes.every(n => { const hu = e._nodeHeight(n), bx = e._boxOf(n);
          return Math.abs(bx.x + bx.w / 2 - (n.y + hu / 2)) < 1e-6 && Math.abs(bx.y + bx.h / 2 - (n.x + 70)) < 1e-6; }); });
      assert.ok(ok);
    });

    it('strata run from top to bottom, and edges flow downward', async () => {
      const r = await page.evaluate(() => { const e = window.eval('editor'), st = e._computeStrata(), rows = {};
        for (const n of e.getGraph().nodes) { const b = e._boxOf(n); (rows[st.get(n.id)] ||= []).push(b.y + b.h / 2); }
        const keys = Object.keys(rows).map(Number).sort((a, c) => a - c), mean = k => rows[k].reduce((a, c) => a + c, 0) / rows[k].length;
        const down = e.getGraph().edges.filter(x => e._edgeP2(x).y > e._edgeP1(x).y).length;
        return { ordered: keys.every((k, i) => i === 0 || mean(k) > mean(keys[i - 1])), down, total: e.getGraph().edges.length }; });
      assert.ok(r.ordered);
      assert.ok(r.down >= r.total - 1, `${r.down} of ${r.total} edges point down`);
    });

    it('inputs are on each node\'s top edge and outputs on its bottom edge, on screen', async () => {
      const ok = await page.evaluate(() => [...document.querySelectorAll('.dag-node')].every(g => {
        const r = g.querySelector('.dag-node-bg').getBoundingClientRect();
        return [...g.querySelectorAll('circle.dag-port-in')].every(c => Math.abs(c.getBoundingClientRect().y + c.getBoundingClientRect().height / 2 - r.y) < 1.5)
            && [...g.querySelectorAll('circle.dag-port-out')].every(c => Math.abs(c.getBoundingClientRect().y + c.getBoundingClientRect().height / 2 - r.bottom) < 1.5);
      }));
      assert.ok(ok);
    });

    it('every port label sits inside its node and none is rotated', async () => {
      const r = await page.evaluate(() => { const bad = []; let n = 0;
        for (const g of document.querySelectorAll('.dag-node')) {
          const box = g.querySelector('.dag-node-bg').getBoundingClientRect();
          for (const t of g.querySelectorAll('text.dag-port-label')) {
            if (t.style.display === 'none' || !t.textContent) continue; n++;
            const r = t.getBoundingClientRect();
            if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) bad.push(t.textContent);
            if (t.getAttribute('transform')) bad.push('rotated:' + t.textContent);
          } }
        return { bad, n }; });
      assert.ok(r.n > 5);
      assert.deepEqual(r.bad, []);
    });

    it('ports sit at k/(n+1) of the node\'s width, on screen', async () => {
      const ok = await page.evaluate(() => [...document.querySelectorAll('.dag-node')].every(g => {
        const box = g.querySelector('.dag-node-bg').getBoundingClientRect();
        return ['in', 'out'].every(dir => { const cs = [...g.querySelectorAll(`circle.dag-port-${dir}`)].map(c => c.getBoundingClientRect().x + c.getBoundingClientRect().width / 2);
          return cs.every((x, i) => Math.abs((x - box.left) / box.width - (i + 1) / (cs.length + 1)) < 0.01); }); }));
      assert.ok(ok);
    });

    describe('working with the flipped graph', () => {
      it('dragging a node keeps it under the pointer, and moves the model transposed', async () => {
        const p0 = await B.nodeRect(page, 'Parse'), j0 = (await model(page)).find(n => n.label === 'Parse');
        const scale = (await B.editorState(page)).scale;
        await page.mouse.move(p0.cx, p0.cy); await page.mouse.down();
        await page.mouse.move(p0.cx + 20, p0.cy + 30, { steps: 4 }); await page.mouse.move(p0.cx + 40, p0.cy + 60, { steps: 4 });
        await page.mouse.up();
        const p1 = await B.nodeRect(page, 'Parse'), j1 = (await model(page)).find(n => n.label === 'Parse');
        near(p1.cx - p0.cx, 40); near(p1.cy - p0.cy, 60);
        near(j1.x - j0.x, 60 / scale, 0.6); near(j1.y - j0.y, 40 / scale, 0.6);
      });

      it('clicking empty canvas creates a node centred on the click', async () => {
        const c = await B.canvasRect(page), x = c.x + 60, y = c.y + c.h - 60, n0 = await nodeCount(page);
        await page.mouse.click(x, y);
        assert.equal(await nodeCount(page), n0 + 1);
        const created = (await model(page)).at(-1), r = await B.nodeRect(page, created.label);
        near(r.cx, x, 2); near(r.cy, y, 2);
      });

      it('dragging from an output port to an input port connects them, with a draft line on the way', async () => {
        const e0 = await edgeCount(page), from = await B.portCentre(page, 'Merge', 'out', 'out'), to = await B.portCentre(page, 'Audit log', 'in', 'in');
        await page.mouse.move(from.x, from.y); await page.mouse.down();
        await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
        assert.equal(await page.evaluate(() => document.querySelector('.dag-edge-draft').style.display !== 'none'), true);
        await page.mouse.move(to.x, to.y, { steps: 5 }); await page.mouse.up();
        assert.equal(await edgeCount(page), e0 + 1);
        assert.equal(await page.evaluate(() => document.querySelector('.dag-edge-draft').style.display), 'none');
      });

      it('dragging up from an input onto empty space creates a node above it', async () => {
        const dst = await B.portCentre(page, 'Dashboard', 'in', 'extra'), n0 = await nodeCount(page);
        await page.mouse.move(dst.x, dst.y); await page.mouse.down(); await page.mouse.move(dst.x + 60, dst.y - 120, { steps: 6 }); await page.mouse.up();
        assert.equal(await nodeCount(page), n0 + 1);
        const created = (await model(page)).at(-1), r = await B.nodeRect(page, created.label), dash = await B.nodeRect(page, 'Dashboard');
        assert.ok(r.cy < dash.cy);
      });

      it('double-clicking an edge splices a node into it', async () => {
        const n0 = await nodeCount(page), e0 = await edgeCount(page);
        const mid = await page.evaluate(() => { const e = window.eval('editor'); const ed = e.getGraph().edges.find(x => x.fromNodeId === 'n4' && x.toNodeId === 'n6');
          const b = e._bezierAt(e._edgeP1(ed), e._edgeP2(ed), 0.5), r = document.querySelector('.dag-svg').getBoundingClientRect();
          return { x: r.x + e._viewX + b.x * e._scale, y: r.y + e._viewY + b.y * e._scale }; });
        await page.mouse.click(mid.x, mid.y, { count: 2, delay: 40 });
        assert.equal(await nodeCount(page), n0 + 1);
        assert.equal(await edgeCount(page), e0 + 1);
      });
    });

    describe('and back to a wide window', () => {
      let flippedModel;
      before(async () => { flippedModel = (await B.editorState(page)).json; await B.resize(page, 1440, 900); });
      it('is unflipped, with the model untouched by flipping', async () => {
        const s = await B.editorState(page);
        assert.equal(s.flipped, false);
        assert.equal(s.json, flippedModel);
      });
      it('is re-fitted again', async () => assert.ok(await B.allNodesInside(page)));
    });
  });

  it('a resize that keeps the orientation still re-fits the graph', async () => {
    const s0 = (await B.editorState(page)).scale;
    await B.resize(page, 1000, 700);
    const s1 = await B.editorState(page);
    assert.equal(s1.flipped, false);
    assert.notEqual(s1.scale, s0);
    assert.ok(await B.allNodesInside(page));
  });

  it('follows the container, not the window', async () => {
    await B.resize(page, 1440, 1300);
    const r = await page.evaluate(() => { const c = document.getElementById('canvas-container').getBoundingClientRect(); return { w: c.width, h: c.height, f: window.eval('editor').flipped }; });
    assert.equal(r.f, r.h > r.w);
  });

  it('survives a burst of resizes', async () => {
    for (const [w, h] of [[760, 900], [1440, 900], [700, 1100], [1300, 600], [760, 900]]) { await page.setViewport({ width: w, height: h }); await B.sleep(60); }
    await B.sleep(500);
    assert.equal((await B.editorState(page)).flipped, true);
    assert.ok(await B.allNodesInside(page));
  });

  it('ran without script errors', () => assert.deepEqual(page.errors, []));
});

describe('resizing while the layout is animating (real browser)', () => {
  let b;
  before(async () => { b = await B.launch(); });
  after(async () => { await b.close(); });

  it('a resize in the middle of the start-up animation leaves a flipped, finished, fitted graph', async () => {
    const page = await b.newPage({ width: 1440, height: 900 });
    await B.sleep(200);
    await page.setViewport({ width: 760, height: 900 });
    await B.layoutDone(page); await B.sleep(300);
    const s = await B.editorState(page);
    assert.equal(s.flipped, true);
    assert.equal(s.active, false);
    assert.ok(await B.allNodesInside(page));
    assert.deepEqual(page.errors, []);
    await b.closePage(page);
  });

  it('laying out again, resizing in the middle, gives the same positions (a good layout stays put)', async () => {
    const page = await b.newPage({ width: 760, height: 900 });
    await B.layoutDone(page);
    const settled = (await B.editorState(page)).json;
    await page.click('[data-action="layout"]');
    await B.sleep(100);
    await page.setViewport({ width: 1440, height: 900 });
    await B.layoutDone(page); await B.sleep(300);
    const s = await B.editorState(page);
    assert.equal(s.flipped, false);
    assert.equal(s.json, settled);
    assert.ok(await B.allNodesInside(page));
    await b.closePage(page);
  });

  it('pinned layout keeps working while flipped: it settles and stays fitted', async () => {
    const page = await b.newPage({ width: 760, height: 900 });
    await B.layoutDone(page);
    await page.evaluate(() => { const e = window.eval('editor'); e._layoutPinned = true; e.addEdge('n1', 'out', 'n12', 'extra'); });
    await B.sleep(200);
    await B.layoutDone(page); await B.sleep(300);
    assert.ok(await B.allNodesInside(page));
    const j = JSON.parse((await B.editorState(page)).json);
    assert.ok(j.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));
    assert.deepEqual(page.errors, []);
    await b.closePage(page);
  });
});
