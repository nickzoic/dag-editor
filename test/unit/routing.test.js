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
const drawn = (editor, e) => editor._edgeShape(e) !== 'curve';                  // straight, lanes or gap: a route, not a fallback
const lanesUsed = (editor, e) => editor._edgeShape(e) === 'lanes';

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

  it('after a layout every edge is drawn by its route, and none falls back to a single curve', () => {
    for (const e of editor.getGraph().edges) assert.ok(drawn(editor, e), `${e.id} is drawn as designed`);
  });

  it('a long edge whose straight line is clear is drawn straight; the lanes are the fallback', () => {
    assert.equal(editor._edgeShape(edge('ad')), 'straight');
    assert.equal(editor._edgeShape(edge('ab')), 'gap');
  });

  it('an edge to the next column has no lanes to pass; an edge skipping columns has one point per column in between', () => {
    assert.equal(editor._routes.get('ab').points.length, 0);
    assert.equal(editor._routes.get('cd').points.length, 0);
    assert.equal(editor._routes.get('ad').points.length, 2, 'a → d skips the columns of b and c');
  });

  it('each point is at the centre of its column, and the points run left to right', () => {
    const pts = editor._routes.get('ad').points;
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

  it('the lanes are one curve per piece: 2k+1 for k points, and one for an edge with no points', () => {
    const lanes = editor._routedSegments(editor._edgeP1(edge('ad')), editor._edgeP2(edge('ad')), editor._routes.get('ad').points);
    assert.equal(lanes.length, 2 * 2 + 1);
    const gap = editor._routedSegments(editor._edgeP1(edge('ab')), editor._edgeP2(edge('ab')), []);
    assert.equal(gap.length, 1);
  });

  it('the lanes are flat across each column they pass through, so they stay in the lane', () => {
    const e = edge('ad'), pts = editor._routes.get('ad').points;
    const segs = editor._routedSegments(editor._edgeP1(e), editor._edgeP2(e), pts);
    const mid = segs[1];                                 // the flat piece through the first lane
    for (const t of [0, 0.25, 0.5, 0.75, 1]) near(cubicAt(mid, t).y, pts[0].y, 1e-9);
  });

  it('every drawn route leaves and arrives horizontally, on the port surfaces', () => {
    for (const e of editor.getGraph().edges) {
      const segs = editor._edgeSegments(e), first = segs[0], last = segs[segs.length - 1];
      near(first.c1.y - first.s.y, (first.c1.y - first.s.y), 1e6);            // (defined)
      assert.ok(first.s.x > editor._edgeP1(e).x - 1e-6 && last.e.x < editor._edgeP2(e).x + 1e-6);
    }
    const segs = editor._routedSegments(editor._edgeP1(edge('ad')), editor._edgeP2(edge('ad')), editor._routes.get('ad').points);
    near(segs[0].c1.y, segs[0].s.y); near(segs[segs.length - 1].c2.y, segs[segs.length - 1].e.y);
  });

  it('hit-testing finds the drawn edge where it is, and not a few pixels away from it', () => {
    const p = cubicAt(editor._edgeSegments(edge('ad'))[0], 0.5);
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
    for (const sg of editor._edgeSegments(e, ctx)) for (let k = 0; k <= 400; k++) {
      const q = DE._cubicAt(sg, k / 400);
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
  const routed = id => drawn(editor, edge(id));
  const curves = id => C(env.document.querySelector(`path[data-id="${id}"]`));

  /** The point on `id`'s straight line where it crosses the centre of column `col` (in model x). */
  const straightAt = (id, col) => {
    const e = edge(id), sg = editor._straightSegments(editor._edgeP1(e), editor._edgeP2(e))[0];
    const x = col * editor._columnWidth() + W / 2, t = (x - sg.s.x) / (sg.e.x - sg.s.x);
    return { x, y: sg.s.y + (sg.e.y - sg.s.y) * t };
  };
  /** Put `label`'s centre at point p (model coordinates). */
  const putCentre = (label, p) => { const n = node(label); n.x = p.x - W / 2; n.y = p.y - editor._nodeHeight(n) / 2; editor._render(); };
  /** Move `label` onto the straight line of `id`, in column `col`: the edge can no longer run straight. */
  const blockStraight = (id, label, col) => putCentre(label, straightAt(id, col));
  beforeEach(() => { env = laidOut(chain()); editor = env.editor; });

  it('a small move of any node keeps every route, and drawings no other node touches are unchanged', () => {
    const bcBefore = env.document.querySelector('path[data-id="bc"]').getAttribute('d');
    node('a').y += 3; editor._render();
    for (const e of editor.getGraph().edges) assert.ok(drawn(editor, e), `${e.id} keeps its route`);
    assert.equal(env.document.querySelector('path[data-id="bc"]').getAttribute('d'), bcBefore);
    assert.equal(drawnThroughNodes(editor), 0);
  });

  it('a node moved onto a long edge\'s straight line makes it use its lanes, and no other edge changes', () => {
    const cdBefore = env.document.querySelector('path[data-id="cd"]').getAttribute('d');
    blockStraight('ad', 'b', 1);
    assert.equal(lanesUsed(editor, edge('ad')), true, 'ad keeps its lanes');
    assert.equal(drawn(editor, edge('ad')), true);
    assert.equal(env.document.querySelector('path[data-id="cd"]').getAttribute('d'), cdBefore, 'cd is untouched');
  });

  it('when the straight line and the lanes are both blocked, the edge is a single curve', () => {
    putCentre('b', editor._routes.get('ad').points[0]);     // on ad's lane in column 1
    blockStraight('ad', 'c', 2);                            // and on its straight line in column 2
    assert.equal(editor._edgeShape(edge('ad')), 'curve');
    assert.equal(curves('ad'), 1);
  });

  it('a lane that is blocked does not matter while the straight line is clear', () => {
    putCentre('b', editor._routes.get('ad').points[0]);
    assert.equal(editor._edgeShape(edge('ad')), 'straight');
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
    for (const e of editor.getGraph().edges) assert.ok(drawn(editor, e));
  });

  it('adding an edge leaves the routes of the others alone, and gives the new edge none', () => {
    editor.addEdge('b', 'out', 'd', 'in');
    assert.equal(routed('ad'), true);
    assert.equal(editor._edgeShape(editor.getGraph().edges.at(-1)), 'curve');
  });

  it('a port change that moves an endpoint never leaves an edge drawn through a node', () => {
    editor.setPortLabel('b', 'input', 'in', 'a much longer port label');
    assert.equal(drawnThroughNodes(editor), 0);
  });

  it('undoing a change that blocked a straight line brings the straight line back', () => {
    editor._snapshot();                                  // the laid-out state
    blockStraight('ad', 'b', 1);
    editor._snapshot();
    assert.equal(lanesUsed(editor, edge('ad')), true);
    editor.undo();
    assert.equal(editor._edgeShape(edge('ad')), 'straight');
  });

  it('laying out again restores every route', () => {
    blockStraight('ad', 'b', 1);
    editor.autoLayout(true); env.settle();
    for (const e of editor.getGraph().edges) assert.ok(drawn(editor, e));
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
    for (const sg of editor._routedSegments(editor._edgeP1(e), editor._edgeP2(e), editor._routes.get('ad').points)) {
      near(sg.c1.x, sg.s.x); near(sg.c2.x, sg.e.x);          // vertical at both ends of every piece
    }
    const segs = editor._edgeSegments(e);
    assert.ok(segs[0].s.y > editor._edgeP1(e).y - 1e-9 && segs[segs.length - 1].e.y < editor._edgeP2(e).y + 1e-9);
  });

  it('the lanes start on the output port and end on the input port, flipped or not', () => {
    const e = editor.getGraph().edges.find(x => x.id === 'ad'), pts = editor._routes.get('ad').points;
    editor._flipped = true;
    const flipped = editor._routedSegments(editor._edgeP1(e), editor._edgeP2(e), pts);
    assert.ok(flipped[0].s.y > editor._edgeP1(e).y);                         // flipped: out of its bottom edge
    editor._flipped = false;
    const plain = editor._routedSegments(editor._edgeP1(e), editor._edgeP2(e), pts);
    assert.equal(plain.length, flipped.length);
    near(plain[0].s.y, editor._edgeP1(e).y, 1e-9);                           // unflipped: out of the port's right side
    assert.ok(plain[0].s.x > editor._edgeP1(e).x);
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
      for (const e of editor.getGraph().edges) assert.ok(drawn(editor, e), 'every edge is drawn as designed after layout');
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
