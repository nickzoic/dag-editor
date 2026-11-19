'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port, graph, plain, same } = require('../helpers/jsdom-env');

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const W = 140;
const DE = createEnv({ create: false }).win.DAGEditor;          // the class, for its static helpers
const cubicAt = (sg, t) => DE._cubicAt(sg, t);
const routeSegments = (s, e, wps) => DE._routeSegments(s, e, wps);
const C = (e, cls = 'd') => (e.getAttribute(cls) || '').split('C').length - 1;   // number of cubic segments in a path

/* A chain a → b → c → d, with a long edge a → d that has to skip two columns, and a short a → b. */
const chain = () => graph([
  ['a', 'A', 0, 0, [], [port('out')]],
  ['b', 'B', 0, 200, [port('in')], [port('out')]],
  ['c', 'C', 0, 400, [port('in')], [port('out')]],
  ['d', 'D', 0, 100, [port('in')], []],
], [['ab', 'a', 'out', 'b', 'in'], ['bc', 'b', 'out', 'c', 'in'], ['cd', 'c', 'out', 'd', 'in'], ['ad', 'a', 'out', 'd', 'in']]);

/** An editor with `g` laid out and settled. */
function laidOut(g, opts = {}) {
  const env = createEnv(opts);
  env.editor.loadGraph(g);
  env.editor.autoLayout(true);
  env.settle();
  return env;
}

describe('routes from auto-layout', () => {
  let env, editor;
  beforeEach(() => { env = laidOut(chain()); editor = env.editor; });

  it('a settled layout has valid routes for every edge', () => {
    assert.equal(editor._routesValid(), true);
    for (const e of editor.getGraph().edges) assert.ok(editor._routeFor(e) !== null, `${e.id} has a route`);
  });

  it('an edge to the next column has no lanes to pass; an edge skipping columns has one point per column in between', () => {
    const route = id => editor._routeFor(editor.getGraph().edges.find(e => e.id === id));
    assert.equal(route('ab').length, 0);
    assert.equal(route('cd').length, 0);
    assert.equal(route('ad').length, 2, 'a → d skips the columns of b and c');
  });

  it('each point is at the centre of its column, and the points run left to right', () => {
    const e = editor.getGraph().edges.find(x => x.id === 'ad'), pts = editor._routeFor(e);
    const node = id => editor.getGraph().nodes.find(n => n.id === id);
    near(pts[0].x, node('b').x + W / 2);                 // column 1 holds b
    near(pts[1].x, node('c').x + W / 2);                 // column 2 holds c
    assert.ok(pts[1].x > pts[0].x && pts[0].x > node('a').x + W);
  });

  it('the points are lane centres inside the layout, at finite positions with two decimals at most', () => {
    for (const pts of editor._routes.paths.values()) for (const p of pts) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
      near(p.x, Math.round(p.x * 100) / 100); near(p.y, Math.round(p.y * 100) / 100);
    }
  });

  it('the drawn path has one curve per piece: 2k+1 for k points, and one for an edge with no points', () => {
    const d = id => env.document.querySelector(`path[data-id="${id}"]`);
    assert.equal(C(d('ab')), 1);
    assert.equal(C(d('ad')), 2 * 2 + 1);
  });

  it('is flat across each column it passes through, so it stays in the lane', () => {
    const e = editor.getGraph().edges.find(x => x.id === 'ad');
    const segs = editor._edgeSegments(e);
    const pts = editor._routeFor(e);
    // the middle of the first column: the flat piece through the lane has the lane's height exactly
    const mid = segs[1];                             // flat piece from pts[0]-half to pts[0]+half
    for (const t of [0, 0.25, 0.5, 0.75, 1]) near(cubicAt(mid, t).y, pts[0].y, 1e-9);
  });

  it('leaves and arrives horizontally, on the port surfaces', () => {
    const e = editor.getGraph().edges.find(x => x.id === 'ad');
    const segs = editor._edgeSegments(e), first = segs[0], last = segs[segs.length - 1];
    near(first.c1.y, first.s.y); near(last.c2.y, last.e.y);
    assert.ok(first.s.x > editor._edgeP1(e).x && last.e.x < editor._edgeP2(e).x);
  });

  it('hit-testing finds the route where it is drawn, and not a few pixels away from it', () => {
    const e = editor.getGraph().edges.find(x => x.id === 'ad');
    const p = cubicAt(editor._edgeSegments(e)[1], 0.5);
    assert.equal(editor._edgeHitTest(e, p.x, p.y), true);
    assert.equal(editor._edgeHitTest(e, p.x, p.y + 20), false);
  });

  it('the arrowhead is still on the end of the path', () => {
    assert.equal(env.document.querySelector('path[data-id="ad"]').getAttribute('marker-end'), 'url(#dag-arrow)');
  });

  it('the export has no routes in it', () => {
    assert.ok(!/route|lane|waypoint|path/i.test(editor.exportJSON()));
    same(Object.keys(editor.toJSON()).sort(), ['edges', 'nodes', 'version']);
  });

  it('importing the export draws the edges as single curves until the next layout', () => {
    const other = createEnv().editor;
    other.importJSON(editor.exportJSON());
    assert.equal(other._routesValid(), false);
    other.autoLayout(true);
    other.autoLayout(false);
    assert.equal(other.exportJSON(), editor.exportJSON());
  });
});

describe('routes are dropped when the graph changes', () => {
  let env, editor, ad, before;
  beforeEach(() => {
    env = laidOut(chain()); editor = env.editor;
    ad = () => editor.getGraph().edges.find(e => e.id === 'ad');
    before = env.document.querySelector('path[data-id="ad"]').getAttribute('d');
  });

  it('moving any node, even one the route does not touch, makes every edge a single curve', () => {
    assert.equal(C(env.document.querySelector('path[data-id="ad"]')), 5);
    editor.getGraph().nodes.find(n => n.id === 'b').y += 3;
    env.editor._render();
    assert.equal(editor._routesValid(), false);
    assert.equal(editor._edgeSegments(ad()).length, 1);
    assert.equal(C(env.document.querySelector('path[data-id="ad"]')), 1);
  });

  it('undoing a recorded change to the positions brings the routes back', () => {
    editor._snapshot();                                  // the laid-out state
    editor.getGraph().nodes.find(n => n.id === 'b').y += 3;
    editor._snapshot();
    assert.equal(editor._routesValid(), false);
    editor.undo();
    assert.equal(editor._routesValid(), true);
    assert.equal(C(env.document.querySelector('path[data-id="ad"]')), 5);
  });

  it('a layout that has been undone draws single curves again, and one redone draws routes', () => {
    editor.undo();
    assert.equal(editor._routesValid(), false);
    editor.redo();
    assert.equal(editor._routesValid(), true);
    assert.equal(env.document.querySelector('path[data-id="ad"]').getAttribute('d'), before);
  });

  it('adding an edge drops the routes', () => {
    editor.addEdge('b', 'out', 'd', 'in');
    assert.equal(editor._routesValid(), false);
  });

  it('a relabel that changes a node\'s size drops them; one that changes nothing about the geometry keeps them', () => {
    editor.setNodeLabel('b', 'Renamed');                 // one short line: the same size, so the same layout
    assert.equal(editor._routesValid(), true);
    editor.setNodeLabel('b', 'a much longer node label that has to wrap onto several lines');
    assert.equal(editor._routesValid(), false);
  });

  it('a port change that resizes a node drops the routes', () => {
    editor.setPortLabel('b', 'input', 'in', 'a much longer port label');
    assert.equal(editor._routesValid(), false);
  });

  it('laying out again restores them', () => {
    editor.getGraph().nodes.find(n => n.id === 'b').y += 30;
    editor.autoLayout(true); env.settle();
    assert.equal(editor._routesValid(), true);
    assert.equal(C(env.document.querySelector('path[data-id="ad"]')), 5);
  });

  it('a layout that is interrupted before it lands does not use its routes', () => {
    editor.getGraph().nodes.find(n => n.id === 'b').y += 300;
    editor.autoLayout(true); env.clock.advance(60);
    assert.equal(editor._layoutActive, true);
    assert.equal(editor._routesValid(), false);
    editor.autoLayout(false);
    assert.equal(editor._routesValid(), false);
  });

  it('a route that cannot be drawn falls back to the single curve, not a broken path', () => {
    editor._routes.paths.set('ad', [{ x: 9999, y: 0 }, { x: 0, y: 0 }]);     // runs backwards
    assert.equal(editor._routeFor(ad()).length, 2);
    assert.equal(editor._edgeSegments(ad()).length, 1);
  });
});

describe('flipped', () => {
  let env, editor;
  beforeEach(() => { env = laidOut(chain(), { width: 400, height: 700 }); editor = env.editor; });

  it('the route is drawn with the flow running down the screen', () => {
    const e = editor.getGraph().edges.find(x => x.id === 'ad');
    assert.equal(editor.flipped, true);
    for (const sg of editor._edgeSegments(e)) {
      near(sg.c1.x, sg.s.x); near(sg.c2.x, sg.e.x);          // vertical at both ends of every piece
    }
    const segs = editor._edgeSegments(e);
    assert.ok(segs[0].s.y > editor._edgeP1(e).y - 1e-9 && segs[segs.length - 1].e.y < editor._edgeP2(e).y + 1e-9);
  });

  it('the drawing starts on the output port and ends on the input port, flipped or not', () => {
    const e = editor.getGraph().edges.find(x => x.id === 'ad');
    const flipped = editor._edgeSegments(e);
    editor._flipped = false;
    const plainSegs = editor._edgeSegments(e);
    assert.equal(plainSegs.length, flipped.length);
    near(plainSegs[0].s.y, editor._edgeP1(e).y, 1e-9);                       // unflipped: out of the port's right side
    assert.ok(plainSegs[0].s.x > editor._edgeP1(e).x);
    editor._flipped = true;
    assert.ok(flipped[0].s.y > editor._edgeP1(e).y);                         // flipped: out of its bottom edge
  });
});

describe('the route curve itself', () => {
  const sg = (s, e, wps) => routeSegments(s, e, wps);

  it('with no points, one piece that goes from the start to the end in the gap', () => {
    const s = { x: 10, y: 0 }, e = { x: 80, y: 100 };
    const segs = sg(s, e, []);
    assert.equal(segs.length, 1);
    same(segs[0].s, s); same(segs[0].e, e);
  });

  it('one piece in and one out for each point, with flat pieces across the column', () => {
    const segs = sg({ x: 0, y: 0 }, { x: 500, y: 0 }, [{ x: 200, y: 50 }]);
    assert.equal(segs.length, 3);
    near(segs[1].s.y, 50); near(segs[1].e.y, 50);          // the flat piece is at the lane height
    near(segs[1].s.x, 200 - W / 2); near(segs[1].e.x, 200 + W / 2);
  });

  it('refuses points that do not run left to right', () => {
    assert.equal(sg({ x: 0, y: 0 }, { x: 500, y: 0 }, [{ x: 600, y: 0 }]), null);
    assert.equal(sg({ x: 100, y: 0 }, { x: 50, y: 0 }, []), null);
  });
});

describe('routes on random graphs', () => {
  // Random layered graphs, with ports, labels and wrapped nodes. A drawn edge must never pass through a
  // node it does not join, in either orientation. This is the property that routing exists to guarantee.
  const rng = seed => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
  const LABELS = ['', '', 'a', 'x', 'ok', 'records', 'enriched', 'validation_result'];
  const NAMES = ['A', 'Parse', 'Validate the incoming records', '', 'Merge results from every branch'];

  function randomGraph(seed, nMin, nSpan) {
    const r = rng(seed * 104729), pick = a => a[Math.floor(r() * a.length)];
    const n = nMin + Math.floor(r() * nSpan), p = pick([0.05, 0.1, 0.18]);
    const nodes = Array.from({ length: n }, (_, i) => ({ id: 'n' + i, label: pick(NAMES), x: r() * 900, y: r() * 600,
      inputs: Array.from({ length: Math.floor(r() * 5) }, (_, k) => port('i' + k, pick(LABELS))),
      outputs: Array.from({ length: Math.floor(r() * 5) }, (_, k) => port('o' + k, pick(LABELS))) }));
    const edges = []; let k = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (r() < p && nodes[i].outputs.length && nodes[j].inputs.length) {
        edges.push({ id: 'e' + k++, fromNodeId: nodes[i].id, fromPortId: pick(nodes[i].outputs).id, toNodeId: nodes[j].id, toPortId: pick(nodes[j].inputs).id });
      }
    }
    return { version: 2, nodes, edges };
  }

  const samplesOf = (editor, e) => editor._edgeSegments(e).flatMap(sg => Array.from({ length: 13 }, (_, k) => cubicAt(sg, k / 12)));

  for (let seed = 1; seed <= 20; seed++) {
    it(`seed ${seed}: no drawn edge passes through another node, flipped or not, and every route is drawable`, () => {
      const env = createEnv(); const editor = env.editor;
      editor.loadGraph(randomGraph(seed, 2, 30));
      const T = editor._computeLayoutTargets();
      for (const n of editor.getGraph().nodes) { n.x = T.get(n.id).x; n.y = T.get(n.id).y; }
      const valid = editor._routesValid();
      assert.ok(valid, 'the layout is valid for the arrangement it produced');
      for (const flipped of [false, true]) {
        editor._flipped = flipped;
        const boxes = new Map(editor.getGraph().nodes.map(n => [n.id, editor._boxOf(n)]));
        for (const e of editor.getGraph().edges) {
          if (editor._routeFor(e, true)) assert.ok(editor._edgeSegments(e, true).length >= 1);
          for (const q of samplesOf(editor, e)) {
            for (const [id, b] of boxes) {
              if (id === e.fromNodeId || id === e.toNodeId) continue;
              const inside = q.x > b.x + 1.5 && q.x < b.x + b.w - 1.5 && q.y > b.y + 1.5 && q.y < b.y + b.h - 1.5;
              assert.ok(!inside, `edge ${e.id} passes through node ${id} (${flipped ? 'flipped' : 'unflipped'})`);
            }
          }
        }
      }
    });
  }
});
