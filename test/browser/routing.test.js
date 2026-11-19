'use strict';
/* Edge routes in a real browser: the drawn SVG paths, sampled with getPointAtLength, never pass through a node. */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../helpers/browser');

/** For every edge path on the page: how many of its sample points lie inside a node it does not join. */
const throughNodes = page => page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.dag-node')].map(g => ({ id: g.dataset.id, r: g.querySelector('.dag-node-bg').getBoundingClientRect() }));
  const e = window.eval('editor');
  let bad = 0, paths = 0, curves = 0;
  for (const p of document.querySelectorAll('path.dag-edge')) {
    paths++;
    curves += (p.getAttribute('d').match(/C/g) || []).length;
    const edge = e.getGraph().edges.find(x => x.id === p.dataset.id);
    const len = p.getTotalLength();
    for (let i = 0; i <= 200; i++) {
      const pt = p.getPointAtLength(len * i / 200), m = p.getScreenCTM();
      const x = m.a * pt.x + m.c * pt.y + m.e, y = m.b * pt.x + m.d * pt.y + m.f;   // to client coordinates
      for (const b of boxes) {
        if (b.id === edge.fromNodeId || b.id === edge.toNodeId) continue;
        if (x > b.r.left + 1.5 && x < b.r.right - 1.5 && y > b.r.top + 1.5 && y < b.r.bottom - 1.5) { bad++; i = 201; break; }
      }
    }
  }
  return { bad, paths, curves };
});

describe('edge routes, as drawn in a real browser', () => {
  let b;
  before(async () => { b = await B.launch(); });
  after(async () => { await b.close(); });

  for (const [name, w, h] of [['landscape', 1440, 900], ['portrait', 760, 1100]]) {
    it(`the demo\'s edges avoid every node they do not join (${name})`, async () => {
      const page = await b.newPage({ width: w, height: h });
      await B.layoutDone(page); await B.sleep(200);
      const r = await throughNodes(page);
      assert.equal(r.paths, 15);
      assert.equal(r.bad, 0, 'no sampled point of any edge lies inside a node it does not join');
      assert.ok(r.curves > r.paths, 'the routed edges are drawn as several curves');
      assert.deepEqual(page.errors, []);
      await b.closePage(page);
    });
  }

  it('a small drag keeps every route, and a drag that puts a node across a route drops only that route', async () => {
    const page = await b.newPage({ width: 1440, height: 900 });
    await B.layoutDone(page);
    const routedCount = () => page.evaluate(() => { const e = window.eval('editor');
      return e.getGraph().edges.filter(x => e._routeFor(x) !== null).length; });
    assert.equal(await routedCount(), 15);
    const before = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('path.dag-edge')].map(p => [p.dataset.id, p.getAttribute('d')])));

    const r = await B.nodeRect(page, 'Warehouse');
    await page.mouse.move(r.cx, r.cy); await page.mouse.down(); await page.mouse.move(r.cx + 20, r.cy, { steps: 4 }); await page.mouse.up();
    assert.equal(await routedCount(), 15, 'a small move of one node keeps every route');
    const after = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('path.dag-edge')].map(p => [p.dataset.id, p.getAttribute('d')])));
    const moved = Object.keys(before).filter(id => before[id] !== after[id]);
    assert.ok(moved.length <= 3, `only the edges into Warehouse can have changed (${moved.join(', ')})`);
    assert.equal((await throughNodes(page)).bad, 0);

    // drag Customers onto the lane of a long edge: the route it now lies across must be dropped
    const lane = await page.evaluate(() => {
      const e = window.eval('editor'), ctx = e._routeContext(), C = window.eval('DAGEditor');
      for (const ed of e.getGraph().edges) {
        const segs = e._drawnRoute(ed, ctx);
        if (!segs || segs.length < 3) continue;
        const p = C._cubicAt(segs[1], 0.5), r = document.querySelector('.dag-svg').getBoundingClientRect();
        return { id: ed.id, x: r.x + e._viewX + p.x * e._scale, y: r.y + e._viewY + p.y * e._scale };
      }
      return null;
    });
    assert.ok(lane, 'there is a routed edge with a lane to aim at');
    const c = await B.nodeRect(page, 'Customers');
    await page.mouse.move(c.cx, c.cy); await page.mouse.down(); await page.mouse.move(lane.x, lane.y, { steps: 10 }); await page.mouse.up();
    assert.ok(await routedCount() < 15, `a node moved onto the lane of ${lane.id} drops that route`);

    await page.click('[data-action="layout"]');
    await B.layoutDone(page); await B.sleep(200);
    assert.equal(await routedCount(), 15);
    assert.equal((await throughNodes(page)).bad, 0);
    await b.closePage(page);
  });

  it('the routes are not in the exported graph', async () => {
    const page = await b.newPage({ width: 1440, height: 900 });
    await B.layoutDone(page);
    const json = await page.evaluate(() => window.eval('editor').exportJSON());
    assert.ok(!/route|lane|waypoint/i.test(json));
    await b.closePage(page);
  });
});
