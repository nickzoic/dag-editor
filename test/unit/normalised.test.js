'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port, graph, same } = require('../helpers/jsdom-env');

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

/* A graph spread over 1000 × 300 px of editor units. */
const spread = () => graph([
  ['a', 'A', 1000, 200, [], [port('o')]],
  ['b', 'B', 1300, 200, [port('i')], [port('o')]],
  ['c', 'C', 1300, 500, [port('i')], []],
], [['e1', 'a', 'o', 'b', 'i'], ['e2', 'b', 'o', 'c', 'i']]);

describe('normalised export (version 3)', () => {
  let editor;
  beforeEach(() => { editor = createEnv().editor; editor.loadGraph(spread()); });

  it('the graph\'s larger extent runs from 0 to 1, and the other axis is in proportion', () => {
    const j = editor.toJSON();
    assert.equal(j.version, 3);
    const xs = j.nodes.map(n => n.x), ys = j.nodes.map(n => n.y);
    near(Math.min(...xs), 0); near(Math.min(...ys), 0);
    near(Math.max(...xs), 1);                          // x is the larger extent here (300 px down, 300 px across: equal)
    assert.ok(Math.max(...xs, ...ys) <= 1);
  });

  it('positions are rounded to six decimal places', () => {
    const e = createEnv().editor;
    e.loadGraph(graph([['a', 'A', 0, 0], ['b', 'B', 1, 1 / 3]]));
    for (const n of e.toJSON().nodes) for (const v of [n.x, n.y]) assert.equal(v, Math.round(v * 1e6) / 1e6);
  });

  it('an empty graph exports no nodes, and a single node sits at the origin', () => {
    const e = createEnv().editor;
    same(e.toJSON().nodes, []);
    e.addNode('Only', 500, 700);
    same([e.toJSON().nodes[0].x, e.toJSON().nodes[0].y], [0, 0]);
  });

  it('the export does not depend on the size of the window it was made in', () => {
    const big = createEnv({ width: 1600, height: 1000 }).editor, small = createEnv({ width: 300, height: 200 }).editor;
    big.loadGraph(spread()); small.loadGraph(spread());
    assert.equal(big.exportJSON(), small.exportJSON());
  });

  it('exporting, importing and exporting again gives the same text', () => {
    const first = editor.exportJSON();
    const again = createEnv().editor; again.importJSON(first);
    assert.equal(again.exportJSON(), first);
  });

  it('a graph exported from one window size imports the same layout into another', () => {
    const exported = editor.exportJSON();
    const a = createEnv({ width: 1200, height: 800 }).editor, b = createEnv({ width: 400, height: 700 }).editor;
    a.importJSON(exported); b.importJSON(exported);
    for (const n of a.getGraph().nodes) {
      const m = b.getGraph().nodes.find(x => x.id === n.id);
      near(n.x, m.x, 1e-9); near(n.y, m.y, 1e-9);     // model units do not depend on the window
    }
  });

  it('imported nodes are clear of each other: no two overlap in either axis', () => {
    const e = createEnv().editor;
    e.importJSON(editor.exportJSON());
    const ns = e.getGraph().nodes;
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const dx = Math.abs(ns[i].x - ns[j].x), dy = Math.abs(ns[i].y - ns[j].y);
      const H = Math.max(...ns.map(n => e._nodeHeight(n)));
      assert.ok(dx >= 140 || dy >= H, `${ns[i].id} and ${ns[j].id} are clear of each other`);
    }
  });

  it('a version 3 import gives its nodes the spacing needed to be clear, and no more', () => {
    const e = createEnv().editor;
    e.fromJSON({ version: 3, nodes: [
      { id: 'a', label: 'A', x: 0, y: 0, inputs: [], outputs: [] },
      { id: 'b', label: 'B', x: 1, y: 0, inputs: [], outputs: [] }], edges: [] });
    near(e.getGraph().nodes[1].x - e.getGraph().nodes[0].x, 140 + 40, 1e-9);
  });

  it('version 1 and 2 files are still read as they were (pixels)', () => {
    const e = createEnv().editor;
    e.importJSON(JSON.stringify({ version: 2, nodes: [{ id: 'a', label: 'A', x: 1000, y: 250, inputs: [], outputs: [] }], edges: [] }));
    same([e.getGraph().nodes[0].x, e.getGraph().nodes[0].y], [1000, 250]);
  });

  it('the editor\'s own positions are unchanged by exporting', () => {
    const before = JSON.stringify(editor.getGraph().nodes.map(n => [n.x, n.y]));
    editor.exportJSON();
    assert.equal(JSON.stringify(editor.getGraph().nodes.map(n => [n.x, n.y])), before);
  });
});

describe('hooks', () => {
  it('each change calls its hook, with the node or edge involved', () => {
    const env = createEnv(); const e = env.editor;
    e.addNode('A', 0, 0);
    assert.equal(env.events[0].type, 'selected');
    assert.equal(env.events[1].type, 'created');
    e.addNode('B', 300, 0);
    e.addEdge('n1', 'out', 'n2', 'in');
    assert.equal(env.events.at(-1).type, 'edge-created');
    e.deleteEdge('e1');
    assert.equal(env.events.at(-1).type, 'edge-deleted');
  });

  it('onMoveNode fires once when a drag ends, and only if the node moved', () => {
    const env = createEnv(); const e = env.editor;
    e.loadGraph(graph([['a', 'A', 100, 100]]));
    const svg = env.container.querySelector('svg.dag-svg');
    const c = env.client(100 + 70, 100 + 23);
    env.mouse(svg, 'mousedown', c.x, c.y); env.mouse(svg, 'mouseup', c.x, c.y);            // a click
    assert.equal(env.moves.length, 0, 'a click is not a move');
    env.mouse(svg, 'mousedown', c.x, c.y); env.mouse(svg, 'mousemove', c.x + 30, c.y + 10); env.mouse(svg, 'mousemove', c.x + 60, c.y + 20); env.mouse(svg, 'mouseup', c.x + 60, c.y + 20);
    assert.equal(env.moves.length, 1);
    assert.equal(env.moves[0].id, 'a');
    assert.ok(env.moves[0].x > 100);
  });

  it('onMoveNode is not called for automatic layout', () => {
    const env = createEnv(); const e = env.editor;
    e.loadGraph(graph([['a', 'A', 0, 0], ['b', 'B', 0, 200]], [['e1', 'a', 'out', 'b', 'in']]));
    e.autoLayout(true); env.settle();
    assert.equal(env.moves.length, 0);
  });

  it('onNotice is told why an edge was refused', () => {
    const env = createEnv(); const e = env.editor;
    e.loadGraph(graph([['a', 'A', 0, 0], ['b', 'B', 300, 0]]));
    e.addEdge('a', 'out', 'b', 'in');
    e.addEdge('b', 'out', 'a', 'in');
    assert.match(env.notices.at(-1), /cycle/);
  });

  it('onLayoutChange and onPinChange report state, and the defaults do nothing', () => {
    const env = createEnv(); const e = env.editor;
    e.loadGraph(graph([['a', 'A', 0, 0]]));
    e.setLayoutPinned(true);
    assert.equal(e.layoutPinned, true);
    assert.deepEqual(env.pins, [true]);
    assert.ok(env.layouts.includes(true));
    e.setLayoutPinned(true);                             // no change: no report
    assert.deepEqual(env.pins, [true]);
    const bare = createEnv({ create: false }).win.DAGEditor;
    assert.equal(typeof bare.prototype.onAddNode, 'function');
  });

  it('a host can override a hook by subclassing, or on an instance', () => {
    const env = createEnv({ create: false });
    const seen = [];
    class Host extends env.win.DAGEditor { onAddNode(node) { seen.push(node.label); } }
    const sub = new Host(env.container);
    sub.addNode('Subclassed', 0, 0);
    const other = createEnv(); other.editor.onAddNode = node => seen.push('instance:' + node.label);
    other.editor.addNode('Instance', 0, 0);
    assert.deepEqual(seen, ['Subclassed', 'instance:Instance']);
  });
});

describe('the default hooks', () => {
  it('every hook exists on the class and does nothing by default, so a bare editor is safe to drive', () => {
    const env = createEnv({ create: false });
    const HOOKS = ['onAddNode', 'onDeleteNode', 'onSelectNode', 'onDeselectNode', 'onSelectEdge', 'onDeselectEdge',
                   'onUpdateNode', 'onAddEdge', 'onDeleteEdge', 'onMoveNode', 'onNotice', 'onLayoutChange', 'onPinChange'];
    const bare = new env.win.DAGEditor(env.container);
    for (const h of HOOKS) {
      assert.equal(typeof env.win.DAGEditor.prototype[h], 'function', h);
      assert.equal(env.win.DAGEditor.prototype[h].call(bare, {}, {}), undefined, h);
    }
    bare.addNode('Quiet', 0, 0);                         // a real change, reported to the no-op defaults
    bare.setLayoutPinned(true);
    bare.setLayoutPinned(false);
    assert.equal(bare.getGraph().nodes.length, 1);
  });
});
