'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port, graph, same } = require('../helpers/jsdom-env');

describe('unusual input', () => {
  let env, editor;
  beforeEach(() => { env = createEnv(); editor = env.editor; });

  it('an output port with no label gets an empty one', () => {
    const n = new env.win.DAGNode({ id: 'a', outputs: [{ id: 'o' }] });
    assert.equal(n.outputs[0].label, '');
  });

  it('fromJSON treats data with no version as version 1', () => {
    editor.fromJSON({ nodes: [{ id: 'n1', label: 'A', x: 0, y: 0 }], edges: [] });
    assert.equal(editor.getGraph().nodes[0].inputs.length, 1);
  });

  it('addPort keeps finding a free id however many ports there already are', () => {
    editor.addNode('A', 0, 0);
    for (let i = 0; i < 4; i++) editor.addPort('n1', 'input');
    same(editor.getGraph().nodes[0].inputs.map(p => p.id), ['in', 'in2', 'in3', 'in4', 'in5']);
  });

  it('addNode with only an x or only a y fills in the other from the middle of the view', () => {
    const onlyY = editor.addNode('Y', undefined, 77);
    assert.equal(onlyY.y, 77);
    assert.ok(Number.isFinite(onlyY.x));
  });

  it('clicking on the toolbar itself, away from any button, does nothing', () => {
    env.container.querySelector('.dag-brand').click();
    env.container.querySelector('.dag-toolbar').click();
    env.container.querySelector('.dag-toolbar').dispatchEvent(new env.win.MouseEvent('dblclick', { bubbles: true }));
    assert.equal(editor.getGraph().nodes.length, 0);
    assert.equal(editor._layoutPinned, false);
  });

  it('Ctrl+Z works with a capital Z too (caps lock)', () => {
    editor.addNode('A', 0, 0); editor.addNode('B', 0, 0);
    env.key('Z', { ctrlKey: true });
    assert.equal(editor.getGraph().nodes.length, 1);
  });

  it('a layout frame that arrives after the layout was stopped does nothing', () => {
    editor.loadGraph(graph([['a', 'A', 0, 0]]));
    assert.doesNotThrow(() => editor._layoutTick());
    assert.equal(editor._layoutActive, false);
  });

  it('the cycle check copes with diamonds, where two paths reach the same node', () => {
    editor.loadGraph(graph([['a', 'A', 0, 0], ['b', 'B', 0, 0], ['c', 'C', 0, 0], ['d', 'D', 0, 0]],
      [['e1', 'a', 'out', 'b', 'in'], ['e2', 'a', 'out', 'c', 'in'], ['e3', 'b', 'out', 'd', 'in'], ['e4', 'c', 'out', 'd', 'in']]));
    assert.equal(editor.addEdge('d', 'out', 'a', 'in'), false);
    assert.equal(editor.addEdge('b', 'out', 'c', 'in'), true, 'but a cross-link that makes no cycle is fine');
  });

  it('double-clicking the second of two edges splices into that one', () => {
    editor.loadGraph(graph([['a', 'A', 0, 0], ['b', 'B', 400, 0], ['c', 'C', 400, 300]], [['e1', 'a', 'out', 'b', 'in'], ['e2', 'a', 'out', 'c', 'in']]));
    const e2 = editor.getGraph().edges[1], m = editor._bezierAt(editor._edgeP1(e2), editor._edgeP2(e2), 0.5), p = env.client(m.x, m.y);
    env.mouse(env.container.querySelector('svg.dag-svg'), 'dblclick', p.x, p.y);
    assert.ok(!editor.getGraph().edges.some(e => e.id === 'e2'));
    assert.ok(editor.getGraph().edges.some(e => e.id === 'e1'));
  });
});

describe('graphs that are not valid DAGs', () => {
  // loadGraph / fromJSON do not check for cycles, so the editor must at least not fall over
  const cyclic = () => graph([['a', 'A', 0, 0], ['b', 'B', 300, 0], ['c', 'C', 600, 0]],
    [['e1', 'a', 'out', 'b', 'in'], ['e2', 'b', 'out', 'c', 'in'], ['e3', 'c', 'out', 'a', 'in']]);

  it('can load and draw one, and lay it out', () => {
    const env = createEnv(); env.editor.loadGraph(cyclic());
    assert.equal(env.document.querySelectorAll('path.dag-edge').length, 3);
    env.editor.autoLayout(true);
    assert.doesNotThrow(() => env.settle());
    for (const n of env.editor.getGraph().nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
  });

  it('deleting a node in a cycle does not bridge across it into a loop', () => {
    const env = createEnv(); env.editor.loadGraph(cyclic());
    assert.doesNotThrow(() => env.editor.deleteNode('b'));
    assert.ok(!env.editor.getGraph().edges.some(e => e.fromNodeId === e.toNodeId), 'no self-loop was created');
  });

  it('refuses to add anything that closes yet another cycle', () => {
    const env = createEnv(); env.editor.loadGraph(cyclic());
    assert.equal(env.editor.addEdge('a', 'out', 'c', 'in'), false);
  });

  it('a node that bridges back to its own source is skipped', () => {
    const env = createEnv();
    env.editor.loadGraph(graph([['a', 'A', 0, 0], ['m', 'M', 300, 0]], [['e1', 'a', 'out', 'm', 'in'], ['e2', 'm', 'out', 'a', 'in']]));
    env.editor.deleteNode('m');
    assert.equal(env.editor.getGraph().edges.length, 0);
  });

  it('a bridge that would close a loop through other nodes is skipped', () => {
    const env = createEnv();
    // a → m → c, and c → a already (data that no editing could produce)
    env.editor.loadGraph(graph([['a', 'A', 0, 0], ['m', 'M', 300, 0], ['c', 'C', 600, 0]],
      [['e1', 'a', 'out', 'm', 'in'], ['e2', 'm', 'out', 'c', 'in'], ['e3', 'c', 'out', 'a', 'in']]));
    env.editor.deleteNode('m');
    same(env.editor.getGraph().edges.map(e => e.id), ['e3']);
  });
});

describe('big graphs', () => {
  // A layered graph of n nodes: every node feeds the next layer, plus some long edges.
  const layered = (layers, width) => {
    const nodes = [], edges = []; let k = 0;
    for (let l = 0; l < layers; l++) for (let i = 0; i < width; i++) nodes.push([`n${l}_${i}`, `N${l}.${i}`, l * 10, i * 10, [port('in'), port('in2')], [port('out'), port('out2')]]);
    for (let l = 0; l + 1 < layers; l++) for (let i = 0; i < width; i++) {
      edges.push([`e${k++}`, `n${l}_${i}`, 'out', `n${l + 1}_${i}`, 'in']);
      edges.push([`e${k++}`, `n${l}_${i}`, 'out2', `n${l + 1}_${(i + 1) % width}`, 'in2']);
      if (l + 2 < layers) edges.push([`e${k++}`, `n${l}_${i}`, 'out', `n${l + 2}_${(i + 2) % width}`, 'in2']);
    }
    return graph(nodes, edges);
  };
  const overlap = (editor, flipped) => {
    editor._flipped = flipped;
    const bs = editor.getGraph().nodes.map(n => editor._boxOf(n)); let c = 0;
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i], b = bs[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) c++;
    }
    return c;
  };

  for (const [name, layers, width] of [['small (many attempts)', 4, 4], ['medium (fewer attempts)', 8, 8], ['large (one attempt)', 12, 25]]) {
    it(`lays out a ${name} graph without overlaps or non-finite positions`, () => {
      const env = createEnv(); env.editor.loadGraph(layered(layers, width));
      const T = env.editor._computeLayoutTargets();
      assert.equal(T.size, layers * width);
      for (const n of env.editor.getGraph().nodes) { n.x = T.get(n.id).x; n.y = T.get(n.id).y; assert.ok(Number.isFinite(n.x + n.y)); }
      assert.equal(overlap(env.editor, false), 0, 'unflipped');
      assert.equal(overlap(env.editor, true), 0, 'flipped');
    });
  }
});
