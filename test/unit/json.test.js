'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port, graph, same } = require('../helpers/jsdom-env');
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

const sample = () => graph(
  [['n1', 'Source', 10, 20, [], [port('data', 'data')]], ['n2', 'Sink', 310, 20, [port('in', 'in')], []], ['n7', 'Seven', 0, 0]],
  [['e1', 'n1', 'data', 'n2', 'in'], ['e5', 'n1', 'data', 'n7', 'in']]);

describe('export', () => {
  let env, editor;
  beforeEach(() => { env = createEnv(); editor = env.editor; editor.loadGraph(sample()); });

  it('toJSON is a plain version-3 description of the graph, with positions normalised to [0, 1]', () => {
    const j = editor.toJSON();
    assert.equal(j.version, 3);
    // the sample's extent is 310 px across and 0 down the first column: x spans [0, 1]; y is scaled by the same amount
    const xs = j.nodes.map(n => n.x), ys = j.nodes.map(n => n.y);
    near(Math.min(...xs), 0); near(Math.min(...ys), 0);
    near(Math.max(...xs.concat(ys)), 1);
    assert.ok(xs.concat(ys).every(v => v >= 0 && v <= 1));
    same(j.nodes[0].inputs, []);
    same(j.nodes[0].outputs, [{ id: 'data', label: 'data' }]);
    same(j.edges[0], { id: 'e1', fromNodeId: 'n1', fromPortId: 'data', toNodeId: 'n2', toPortId: 'in' });
  });

  it('exportJSON makes a string, compact or indented', () => {
    assert.equal(typeof editor.exportJSON(), 'string');
    assert.ok(!editor.exportJSON().includes('\n'));
    assert.ok(editor.exportJSON(2).includes('\n  '));
    same(JSON.parse(editor.exportJSON()), editor.toJSON());
  });

  it('getGraph returns the live nodes and edges', () => {
    const g = editor.getGraph();
    assert.ok(g.nodes[0] instanceof env.win.DAGNode);
    assert.ok(g.edges[0] instanceof env.win.DAGEdge);
  });
});

describe('import', () => {
  let src, dst;
  beforeEach(() => { src = createEnv().editor; src.loadGraph(sample()); dst = createEnv().editor; });

  it('a graph survives export then import unchanged', () => {
    dst.importJSON(src.exportJSON());
    assert.equal(dst.exportJSON(), src.exportJSON());
  });

  it('fromJSON and importJSON return the editor, so calls chain', () => {
    assert.equal(dst.fromJSON(src.toJSON()), dst);
    assert.equal(dst.importJSON(src.exportJSON()), dst);
  });

  it('fromJSON rejects things that are not graphs', () => {
    assert.throws(() => dst.fromJSON(null), /plain object/);
    assert.throws(() => dst.fromJSON('x'), /plain object/);
    assert.throws(() => dst.fromJSON({ version: 4, nodes: [] }), /unsupported version 4/);
  });

  it('importJSON rejects text that is not JSON, saying so', () => {
    assert.throws(() => dst.importJSON('{ not json'), /invalid JSON/);
  });

  it('a failed import leaves the existing graph alone', () => {
    dst.loadGraph(sample());
    assert.throws(() => dst.importJSON('nope'));
    assert.equal(dst.getGraph().nodes.length, 3);
  });

  it('replaces whatever was there', () => {
    dst.addNode('Old', 0, 0);
    dst.importJSON(src.exportJSON());
    assert.ok(!dst.getGraph().nodes.some(n => n.label === 'Old'));
  });

  it('keeps issuing fresh ids after a load (no clash with loaded ones)', () => {
    dst.importJSON(src.exportJSON());
    assert.equal(dst.addNode('X', 0, 0).id, 'n8');
    dst.addEdge('n2', 'in', 'n7', 'in');
    dst.addEdge('n7', 'out', 'n8', 'in');
    assert.ok(dst.getGraph().edges.some(e => e.id === 'e6'));
  });

  it('makes the import one undo step', () => {
    dst.addNode('Old', 0, 0);
    dst.importJSON(src.exportJSON());
    dst.undo();
    same(dst.getGraph().nodes.map(n => n.label), ['Old']);
  });
});

describe('loading version 1 graphs', () => {
  it('gives each node one input and one output port, and maps from/to onto them', () => {
    const { editor } = createEnv();
    editor.fromJSON({ version: 1,
      nodes: [{ id: 'n1', label: 'A', x: 0, y: 0 }, { id: 'n2', label: 'B', x: 300, y: 0 }],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }] });
    const [a] = editor.getGraph().nodes;
    same(a.inputs, [{ id: 'in', label: '' }]);
    same(a.outputs, [{ id: 'out', label: '' }]);
    same(editor.getGraph().edges[0].toJSON(), { id: 'e1', fromNodeId: 'n1', fromPortId: 'out', toNodeId: 'n2', toPortId: 'in' });
  });

  it('treats a graph with no version as version 1', () => {
    const { editor } = createEnv();
    editor.loadGraph({ nodes: [{ id: 'n1', label: 'A', x: 0, y: 0 }], edges: [] });
    assert.equal(editor.getGraph().nodes[0].inputs.length, 1);
  });

  it('exports in version 3 afterwards', () => {
    const { editor } = createEnv();
    editor.fromJSON({ version: 1, nodes: [{ id: 'n1', label: 'A', x: 0, y: 0 }], edges: [] });
    assert.equal(editor.toJSON().version, 3);
  });
});

describe('loadGraph', () => {
  it('copes with missing arrays and with edges to nodes that are not there', () => {
    const { editor, document } = createEnv();
    assert.doesNotThrow(() => editor.loadGraph({ version: 2 }));
    assert.doesNotThrow(() => editor.loadGraph({ version: 2,
      nodes: [{ id: 'a', label: 'A', x: 0, y: 0, inputs: [], outputs: [port('o')] }],
      edges: [{ id: 'e1', fromNodeId: 'a', fromPortId: 'o', toNodeId: 'gone', toPortId: 'in' }] }));
    assert.equal(document.querySelector('path[data-id="e1"]').getAttribute('d'), '');
  });

  it('fires no created / deleted events (it replaces the graph wholesale)', () => {
    const { editor, events } = createEnv();
    editor.addNode('Old', 0, 0);
    events.length = 0;
    editor.loadGraph(sample());
    assert.ok(events.every(e => e.type === 'deselected'));
  });

  it('fits the loaded graph to the view', () => {
    const { editor } = createEnv();
    editor.loadGraph(sample());
    const b = editor._boxOf(editor.getGraph().nodes[0]);
    const x = editor._viewX + b.x * editor._scale;
    assert.ok(x >= 0 && x <= editor._svgRect().width);
  });
});
