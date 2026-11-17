'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port, graph, same } = require('../helpers/jsdom-env');

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

/** Boxes of all nodes in the orientation currently shown. */
const boxes = editor => editor.getGraph().nodes.map(n => ({ n, b: editor._boxOf(n) }));
const overlaps = (editor, flipped) => {
  editor._flipped = flipped;
  const bs = boxes(editor); let c = 0;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i].b, b = bs[j].b;
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) c++;
  }
  return c;
};
const apply = editor => { const T = editor._computeLayoutTargets(); for (const n of editor.getGraph().nodes) { n.x = T.get(n.id).x; n.y = T.get(n.id).y; } return T; };

// A graph with the variety the layout has to cope with: fan-out, fan-in, a long edge, multi-port and labelled nodes.
const pipeline = () => graph([
  ['src', 'Source', 0, 0, [], [port('data', 'data')]],
  ['p1', 'Parse', 50, 300, [port('in', 'raw')], [port('out', 'tokens')]],
  ['p2', 'Validate', 20, 10, [port('in', 'raw')], [port('ok', 'ok'), port('err', 'errors')]],
  ['m', 'Merge', 400, 200, [port('a', 'a'), port('b', 'b')], [port('out')]],
  ['log', 'Log', 90, 90, [port('in')], []],
  ['sink', 'Output', 0, 500, [port('in', 'in')], []],
], [
  ['e1', 'src', 'data', 'p1', 'in'], ['e2', 'src', 'data', 'p2', 'in'], ['e3', 'p1', 'out', 'm', 'a'],
  ['e4', 'p2', 'ok', 'm', 'b'], ['e5', 'p2', 'err', 'log', 'in'], ['e6', 'm', 'out', 'sink', 'in'], ['e7', 'src', 'data', 'sink', 'in'],
]);

describe('strata', () => {
  let editor;
  beforeEach(() => { editor = createEnv().editor; });
  const strata = (nodes, edges) => { editor.loadGraph(graph(nodes, edges)); return Object.fromEntries(editor._computeStrata()); };

  it('roots are stratum 0 and each node is one deeper than its deepest predecessor', () => {
    same(strata([['a', 'A', 0, 0], ['b', 'B', 0, 0], ['c', 'C', 0, 0], ['d', 'D', 0, 0]],
      [['e1', 'a', 'out', 'b', 'in'], ['e2', 'b', 'out', 'c', 'in'], ['e3', 'a', 'out', 'c', 'in'], ['e4', 'a', 'out', 'd', 'in']]),
      { a: 0, b: 1, c: 2, d: 1 });
  });

  it('isolated nodes are roots', () => same(strata([['a', 'A', 0, 0], ['b', 'B', 0, 0]], []), { a: 0, b: 0 }));
  it('an empty graph has no strata', () => assert.equal(editor._computeStrata().size, 0));
});

describe('where auto-layout puts things', () => {
  let editor;
  beforeEach(() => { editor = createEnv().editor; editor.loadGraph(pipeline()); });

  it('gives every node a target, with finite coordinates rounded to 0.01 px', () => {
    const T = editor._computeLayoutTargets();
    assert.equal(T.size, 6);
    for (const { x, y } of T.values()) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      near(x, Math.round(x * 100) / 100); near(y, Math.round(y * 100) / 100);
    }
  });

  it('puts every node of a stratum in one column, and every edge pointing left to right', () => {
    const T = editor._computeLayoutTargets(), st = editor._computeStrata(), colX = {};
    for (const [id, t] of T) (colX[st.get(id)] ||= new Set()).add(t.x);
    assert.ok(Object.values(colX).every(s => s.size === 1));
    for (const e of editor.getGraph().edges) assert.ok(T.get(e.fromNodeId).x < T.get(e.toNodeId).x);
  });

  it('anchors the top of the drawing at y = 0', () => {
    const T = editor._computeLayoutTargets();
    assert.equal(Math.min(...[...T.values()].map(t => t.y)), 0);
    assert.equal(Math.min(...[...T.values()].map(t => t.x)), 0);
  });

  it('never overlaps nodes, in either orientation', () => {
    apply(editor);
    assert.equal(overlaps(editor, false), 0, 'unflipped');
    assert.equal(overlaps(editor, true), 0, 'flipped');
  });

  it('is deterministic, and independent of where the nodes started', () => {
    const a = editor._computeLayoutTargets();
    const other = createEnv().editor; other.loadGraph(pipeline());
    for (const n of other.getGraph().nodes) { n.x = (n.x * 7 + 200) % 900; n.y = (n.y * 13 + 70) % 500; }
    const b = other._computeLayoutTargets();
    for (const [id, t] of a) assert.equal(b.get(id).x, t.x, 'columns do not depend on the starting positions');
    const again = editor._computeLayoutTargets();
    for (const [id, t] of a) { assert.equal(again.get(id).x, t.x); assert.equal(again.get(id).y, t.y); }
  });

  it('leaves a layout that is already laid out exactly as it is', () => {
    apply(editor);
    const before = JSON.stringify(editor.toJSON());
    apply(editor); apply(editor);
    assert.equal(JSON.stringify(editor.toJSON()), before);
  });

  it('gives the same result whichever way up the editor is shown', () => {
    editor._flipped = false; const a = editor._computeLayoutTargets();
    editor._flipped = true;  const b = editor._computeLayoutTargets();
    for (const [id, t] of a) { assert.equal(b.get(id).x, t.x); assert.equal(b.get(id).y, t.y); }
  });

  it('lines connected ports up where it can: a chain of one-port nodes comes out level', () => {
    editor.loadGraph(graph([['a', 'A', 0, 90], ['b', 'B', 0, 10], ['c', 'C', 0, 200]], [['e1', 'a', 'out', 'b', 'in'], ['e2', 'b', 'out', 'c', 'in']]));
    const T = editor._computeLayoutTargets();
    near(T.get('a').y, T.get('b').y, 0.02); near(T.get('b').y, T.get('c').y, 0.02);
  });

  it('keeps room for a node made tall by a wrapped label', () => {
    editor.loadGraph(graph([['r', 'Root', 0, 0, [], [port('out')]], ['t1', 'a label long enough to wrap onto several lines here', 0, 0],
      ['t2', 'another label long enough to wrap onto several lines', 0, 0]], [['e1', 'r', 'out', 't1', 'in'], ['e2', 'r', 'out', 't2', 'in']]));
    apply(editor);
    assert.equal(overlaps(editor, false), 0);
    assert.equal(overlaps(editor, true), 0);
  });

  it('copes with nothing, with one node, and with edges to missing nodes', () => {
    editor.loadGraph({ version: 2, nodes: [], edges: [] });
    assert.equal(editor._computeLayoutTargets().size, 0);
    editor.loadGraph(graph([['only', 'Only', 321, 654]]));
    same([...editor._computeLayoutTargets().values()], [{ x: 0, y: 0 }]);
    editor.loadGraph({ version: 2, nodes: [{ id: 'a', label: 'A', x: 0, y: 0, inputs: [], outputs: [port('o')] }],
      edges: [{ id: 'e', fromNodeId: 'a', fromPortId: 'o', toNodeId: 'ghost', toPortId: 'in' }] });
    assert.equal(editor._computeLayoutTargets().size, 1);
  });

  it('copes with edges that name ports that are not there', () => {
    editor.loadGraph(graph([['a', 'A', 0, 0], ['b', 'B', 0, 0]], [['e1', 'a', 'missing', 'b', 'gone']]));
    assert.equal(editor._computeLayoutTargets().size, 2);
  });

  it('handles a long edge across several columns, leaving it a lane between the nodes in between', () => {
    editor.loadGraph(graph([['a', 'A', 0, 0], ['b', 'B', 0, 0], ['c', 'C', 0, 0], ['d', 'D', 0, 0], ['x', 'X', 0, 0]],
      [['e1', 'a', 'out', 'b', 'in'], ['e2', 'b', 'out', 'c', 'in'], ['e3', 'c', 'out', 'd', 'in'], ['e4', 'a', 'out', 'd', 'in'], ['e5', 'a', 'out', 'x', 'in']]));
    apply(editor);
    assert.equal(overlaps(editor, false), 0);
    const st = editor._computeStrata();
    assert.equal(st.get('d'), 3);
  });
});

describe('running auto-layout', () => {
  let env, editor, btn;
  beforeEach(() => { env = createEnv(); editor = env.editor; editor.loadGraph(pipeline()); btn = env.container.querySelector('[data-action="layout"]'); });

  it('animates the nodes to their targets and finishes well inside a second', () => {
    const targets = editor._computeLayoutTargets();
    editor.autoLayout(true);
    assert.equal(editor._layoutActive, true);
    const first = editor.getGraph().nodes.map(n => n.y).join();
    env.clock.advance(150);
    assert.notEqual(editor.getGraph().nodes.map(n => n.y).join(), first, 'it moves while running');
    const ms = env.settle();
    assert.ok(ms + 150 < 1000, `settled after ${ms + 150} ms`);
    assert.equal(editor._layoutActive, false);
    for (const n of editor.getGraph().nodes) { assert.equal(n.x, targets.get(n.id).x); assert.equal(n.y, targets.get(n.id).y); }
  });

  it('keeps the whole graph fitted to the view while it runs', () => {
    editor.autoLayout(true);
    env.clock.advance(100);
    const before = editor._scale;
    env.settle();
    assert.notEqual(editor._scale, before);
    for (const { b } of boxes(editor)) {
      const x = editor._viewX + b.x * editor._scale;
      assert.ok(x >= -0.5 && x + b.w * editor._scale <= editor._svgRect().width + 0.5);
    }
  });

  it('the Layout button and the L key start it, and the button lights up while it runs', () => {
    btn.click();
    assert.equal(editor._layoutActive, true);
    assert.ok(btn.classList.contains('dag-btn-layout--on'));
    env.settle();
    assert.ok(!btn.classList.contains('dag-btn-layout--on'));
    editor.getGraph().nodes[0].y += 400;                 // knock a node out of place, so there is something to do
    env.key('l');
    assert.equal(editor._layoutActive, true);
  });

  it('pressing the button again while it runs stops it where it is', () => {
    btn.click(); env.clock.advance(100);
    btn.click();
    assert.equal(editor._layoutActive, false);
    const frozen = JSON.stringify(editor.toJSON());
    env.clock.advance(500);
    assert.equal(JSON.stringify(editor.toJSON()), frozen);
  });

  it('is one undo step', () => {
    const before = JSON.stringify(editor.toJSON());
    editor.autoLayout(true); env.settle();
    assert.notEqual(JSON.stringify(editor.toJSON()), before);
    editor.undo();
    assert.equal(JSON.stringify(editor.toJSON()), before);
  });

  it('always ends by its deadline, landing exactly on the targets', () => {
    editor.autoLayout(true);
    editor._layoutStartTime -= 5000;                    // pretend it has been running far too long
    env.clock.advance(20);
    assert.equal(editor._layoutActive, false);
    const T = editor._layoutTargets;
    for (const n of editor.getGraph().nodes) assert.equal(n.y, T.get(n.id).y);
  });

  it('ignores nodes deleted while it runs', () => {
    editor.autoLayout(true);
    editor.deleteNode('log');
    assert.doesNotThrow(() => env.settle());
    assert.equal(editor._layoutActive, false);
  });

  it('on an empty graph it ends straight away', () => {
    editor.loadGraph({ version: 2, nodes: [], edges: [] });
    editor.autoLayout(true); env.clock.advance(50);
    assert.equal(editor._layoutActive, false);
  });
});

describe('pinned auto-layout', () => {
  let env, editor, btn, dbl;
  beforeEach(() => {
    env = createEnv(); editor = env.editor; editor.loadGraph(pipeline());
    btn = env.container.querySelector('[data-action="layout"]');
    dbl = () => btn.dispatchEvent(new env.win.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });

  it('a double-click pins it: it lights up, lays out at once, and stays pinned when done', () => {
    dbl();
    assert.equal(editor._layoutPinned, true);
    assert.equal(editor._layoutActive, true);
    assert.ok(btn.classList.contains('dag-btn-layout--pinned'));
    env.settle();
    assert.equal(editor._layoutActive, false);
    assert.ok(btn.classList.contains('dag-btn-layout--pinned'));
    assert.match(btn.title, /pinned/);
  });

  it('a second double-click unpins it, and stops a run in progress', () => {
    dbl(); env.clock.advance(50); dbl();
    assert.equal(editor._layoutPinned, false);
    assert.equal(editor._layoutActive, false);
    assert.ok(!btn.classList.contains('dag-btn-layout--pinned'));
    assert.match(btn.title, /pin/);
  });

  it('Shift+L toggles it from the keyboard', () => {
    env.key('L', { shiftKey: true });
    assert.equal(editor._layoutPinned, true);
    assert.equal(editor._layoutActive, true);
    env.key('L', { shiftKey: true });
    assert.equal(editor._layoutPinned, false);
    assert.equal(editor._layoutActive, false);
    env.key('L', { shiftKey: true }); env.settle();
    env.key('L', { shiftKey: true });                      // unpin after a finished run
    assert.equal(editor._layoutPinned, false);
  });

  it('lays out again when an edge is added or deleted, or a node is deleted, or a graph is loaded', () => {
    dbl(); env.settle();
    editor.addEdge('log', 'in', 'sink', 'in') || editor.addEdge('p1', 'out', 'sink', 'in');
    assert.equal(editor._layoutActive, true, 'edge added'); env.settle();
    editor.deleteEdge(editor.getGraph().edges[0].id);
    assert.equal(editor._layoutActive, true, 'edge deleted'); env.settle();
    editor.deleteNode('sink');
    assert.equal(editor._layoutActive, true, 'node deleted'); env.settle();
    editor.loadGraph(pipeline());
    assert.equal(editor._layoutActive, true, 'graph loaded'); env.settle();
  });

  it('does not lay out for a node with no edges, or for a label change', () => {
    dbl(); env.settle();
    editor.addNode('Lonely', 5, 5);
    assert.equal(editor._layoutActive, false);
    editor.setNodeLabel('src', 'Renamed');
    assert.equal(editor._layoutActive, false);
  });

  it('a change during a run re-aims it at the new arrangement and restarts the clock', () => {
    dbl(); env.clock.advance(300);
    const start = editor._layoutStartTime;
    editor.addEdge('src', 'data', 'log', 'in');
    assert.equal(editor._layoutActive, true);
    assert.ok(editor._layoutStartTime > start);
    env.settle();
    assert.equal(editor._layoutActive, false);
  });

  it('nothing happens on a change when it is not pinned', () => {
    editor.addEdge('src', 'data', 'log', 'in');
    assert.equal(editor._layoutActive, false);
  });

  it('removing a port that takes edges with it re-lays out; removing an unconnected one does not', () => {
    dbl(); env.settle();
    editor.addPort('log', 'output');
    assert.equal(editor._layoutActive, false);
    editor.removePort('src', 'output', 'data');
    assert.equal(editor._layoutActive, true);
  });
});
