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
  const edge = id => editor.getGraph().edges.find(e => e.id === id);

  it('after a layout every edge has a route, and each route is valid for the graph as it is', () => {
    for (const e of editor.getGraph().edges) assert.ok(editor._routeFor(e) !== null, `${e.id} has a route`);
  });

  it('an edge to the next column has no lanes to pass; an edge skipping columns has one point per column in between', () => {
    assert.equal(editor._routeFor(edge('ab')).length, 0);
    assert.equal(editor._routeFor(edge('cd')).length, 0);
    assert.equal(editor._routeFor(edge('ad')).length, 2, 'a → d skips the columns of b and c');
  });

  it('each point is at the centre of its column, and the points run left to right', () => {
    const pts = editor._routeFor(edge('ad'));
    const node = id => editor.getGraph().nodes.find(n => n.id === id);
    near(pts[0].x, node('b').x + W / 2);                 // column 1 holds b
    near(pts[1].x, node('c').x + W / 2);                 // column 2 holds c
    assert.ok(pts[1].x > pts[0].x && pts[0].x > node('a').x + W);
  });

  it('the points are lane centres at finite positions with two decimals at most', () => {
    for (const r of editor._routes.values()) for (const p of r.points) {
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
    const segs = editor._edgeSegments(edge('ad')), pts = editor._routeFor(edge('ad'));
    const mid = segs[1];                                 // the flat piece through the first lane
    for (const t of [0, 0.25, 0.5, 0.75, 1]) near(cubicAt(mid, t).y, pts[0].y, 1e-9);
  });

  it('leaves and arrives horizontally, on the port surfaces', () => {
    const segs = editor._edgeSegments(edge('ad')), first = segs[0], last = segs[segs.length - 1];
    near(first.c1.y, first.s.y); near(last.c2.y, last.e.y);
    assert.ok(first.s.x > editor._edgeP1(edge('ad')).x && last.e.x < editor._edgeP2(edge('ad')).x);
  });

  it('hit-testing finds the route where it is drawn, and not a few pixels away from it', () => {
    const p = cubicAt(editor._edgeSegments(edge('ad'))[1], 0.5);
    assert.equal(editor._edgeHitTest(edge('ad'), p.x, p.y), true);
    assert.equal(editor._edgeHitTest(edge('ad'), p.x, p.y + 20), false);
  });

  it('the arrowhead is still on the end of the path', () => {
    assert.equal(env.document.querySelector('path[data-id="ad"]').getAttribute('marker-end'), 'url(#dag-arrow)');
  });

  it('the export has no routes in it', () => {
    assert.ok(!/route|lane|waypoint|path|span|dep/i.test(editor.exportJSON()));
    same(Object.keys(editor.toJSON()).sort(), ['edges', 'nodes', 'version']);
  });

  it('importing the export draws every edge as a single curve until the next layout', () => {
    const other = createEnv().editor;
    other.importJSON(editor.exportJSON());
    for (const e of other.getGraph().edges) assert.equal(other._routeFor(e), null);
    other.autoLayout(true);
    other.autoLayout(false);
    assert.equal(other.exportJSON(), editor.exportJSON());
  });
});

/** How many sample points of the edges as they are drawn lie inside a node they do not join. */
function drawnThroughNodes(editor) {
  const ctx = editor._routeContext();
  let hits = 0;
  for (const e of editor.getGraph().edges) {
    for (const sg of editor._edgeSegments(e, ctx)) for (let k = 0; k <= 16; k++) {
      const q = DE._cubicAt(sg, k / 16);
      for (const { id, b } of ctx.boxes) {
        if (id === e.fromNodeId || id === e.toNodeId) continue;
        if (q.x > b.x + 1.5 && q.x < b.x + b.w - 1.5 && q.y > b.y + 1.5 && q.y < b.y + b.h - 1.5) { hits++; break; }
      }
    }
  }
  return hits;
}

describe('routes are dropped per edge, when the drawing is affected', () => {
  let env, editor;
  const edge = id => editor.getGraph().edges.find(e => e.id === id);
  const node = id => editor.getGraph().nodes.find(n => n.id === id);
  const routed = id => editor._routeFor(edge(id)) !== null;
  const curves = id => C(env.document.querySelector(`path[data-id="${id}"]`));

  /** Move `label` so that it sits on the lane `id` passes through in its first column (blocking that route). */
  const blockRoute = (id, label) => {
    const pt = editor._routeFor(edge(id))[0];
    const n = node(label), hu = editor._nodeHeight(n);
    n.x = pt.x - W / 2; n.y = pt.y - hu / 2;
    editor._render();
  };

  beforeEach(() => { env = laidOut(chain()); editor = env.editor; });

  it('a small move of any node keeps every route, and drawings no other node touches are unchanged', () => {
    const bcBefore = env.document.querySelector('path[data-id="bc"]').getAttribute('d');
    node('a').y += 3; editor._render();
    for (const e of editor.getGraph().edges) assert.ok(editor._routeFor(e) !== null, `${e.id} keeps its route`);
    assert.equal(env.document.querySelector('path[data-id="bc"]').getAttribute('d'), bcBefore);
    assert.equal(drawnThroughNodes(editor), 0);
  });

  it('a node moved onto one route\'s lane drops that route, and no other', () => {
    blockRoute('ad', 'b');
    assert.equal(routed('ad'), false, 'b now sits in ad\'s lane');
    assert.equal(routed('cd'), true, 'cd does not cross b\'s column');
    assert.equal(curves('ad'), 1, 'the blocked edge is drawn as a single curve');
  });

  it('a node moved away from a curve it was clear of leaves that route as it was', () => {
    const before = env.document.querySelector('path[data-id="cd"]').getAttribute('d');
    node('a').y -= 200; editor._render();               // far from cd, which is drawn in the lower columns
    assert.equal(env.document.querySelector('path[data-id="cd"]').getAttribute('d'), before);
  });

  it('a change to the column width drops every route, since the lanes are placed by it', () => {
    const before = editor._columnWidth();
    editor.setNodeLabel('d', 'word '.repeat(60));       // a tall node raises the column pitch
    assert.ok(editor._columnWidth() > before);
    for (const e of editor.getGraph().edges) assert.equal(editor._routeFor(e), null);
    editor.setNodeLabel('d', 'D');                       // back to the old width: the routes are valid again
    assert.equal(routed('bc'), true);
  });

  it('a relabel that changes nothing about the geometry keeps every route', () => {
    editor.setNodeLabel('b', 'Renamed');                 // one short line: the same size, so the same layout
    for (const e of editor.getGraph().edges) assert.ok(editor._routeFor(e) !== null);
  });

  it('adding an edge leaves the routes of the others alone, and gives the new edge none', () => {
    editor.addEdge('b', 'out', 'd', 'in');
    assert.equal(routed('ad'), true);
    assert.equal(editor._routeFor(editor.getGraph().edges.at(-1)), null);
  });

  it('a port change that moves an endpoint never leaves an edge drawn through a node', () => {
    editor.setPortLabel('b', 'input', 'in', 'a much longer port label');
    assert.equal(drawnThroughNodes(editor), 0);
  });

  it('undoing a change that blocked a route brings the route back', () => {
    editor._snapshot();                                  // the laid-out state
    blockRoute('ad', 'b');
    editor._snapshot();
    assert.equal(routed('ad'), false);
    editor.undo();
    assert.equal(routed('ad'), true);
    assert.equal(curves('ad'), 5);
  });

  it('laying out again restores every route', () => {
    blockRoute('ad', 'b');
    editor.autoLayout(true); env.settle();
    for (const e of editor.getGraph().edges) assert.ok(editor._routeFor(e) !== null);
  });

  it('while a layout is still moving the nodes, nothing is drawn through a node', () => {
    node('a').y += 300;
    editor.autoLayout(true); env.clock.advance(60);
    assert.equal(editor._layoutActive, true);
    assert.equal(drawnThroughNodes(editor), 0);
    editor.autoLayout(false);
    assert.equal(drawnThroughNodes(editor), 0);
  });

  it('a route that cannot be drawn falls back to the single curve, not a broken path', () => {
    editor._routes.get('ad').points = [{ x: 9999, y: 0 }, { x: 0, y: 0 }];     // runs backwards
    assert.equal(editor._routeFor(edge('ad')), null, 'and no route is reported for it');
    assert.equal(editor._edgeSegments(edge('ad')).length, 1);
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
      for (const e of editor.getGraph().edges) assert.ok(editor._routeFor(e) !== null, 'every edge is routed after layout');
      for (const flipped of [false, true]) {
        editor._flipped = flipped;
        const boxes = new Map(editor.getGraph().nodes.map(n => [n.id, editor._boxOf(n)]));
        for (const e of editor.getGraph().edges) {
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
