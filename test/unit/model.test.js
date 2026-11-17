'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port, graph, same } = require('../helpers/jsdom-env');

const types = events => events.map(e => e.type);

describe('DAGNode and DAGEdge', () => {
  let win;
  beforeEach(() => { win = createEnv({ create: false }).win; });

  it('DAGNode has sensible defaults', () => {
    const n = new win.DAGNode({ id: 'a' });
    same([n.id, n.label, n.x, n.y, n.inputs, n.outputs], ['a', '', 0, 0, [], []]);
  });

  it('DAGNode copies its ports and gives them empty labels by default', () => {
    const src = [{ id: 'i' }, { id: 'j', label: 'J' }];
    const n = new win.DAGNode({ id: 'a', inputs: src });
    same(n.inputs.map(p => p.label), ['', 'J']);
    src[0].id = 'changed';
    assert.equal(n.inputs[0].id, 'i', 'mutating the source must not affect the node');
  });

  it('DAGNode round-trips through JSON', () => {
    const n = new win.DAGNode({ id: 'a', label: 'A', x: 1, y: 2, inputs: [port('i', 'in')], outputs: [port('o')] });
    const copy = win.DAGNode.fromJSON(JSON.parse(JSON.stringify(n)));
    same(copy.toJSON(), n.toJSON());
    same(n.toJSON(), { id: 'a', label: 'A', x: 1, y: 2, inputs: [{ id: 'i', label: 'in' }], outputs: [{ id: 'o', label: '' }] });
  });

  it('DAGEdge round-trips through JSON', () => {
    const e = new win.DAGEdge({ id: 'e1', fromNodeId: 'a', fromPortId: 'o', toNodeId: 'b', toPortId: 'i' });
    same(win.DAGEdge.fromJSON(e.toJSON()).toJSON(), { id: 'e1', fromNodeId: 'a', fromPortId: 'o', toNodeId: 'b', toPortId: 'i' });
  });
});

describe('creating an editor', () => {
  it('requires an HTMLElement', () => {
    const { win } = createEnv({ create: false });
    assert.throws(() => new win.DAGEditor('#c'), /HTMLElement/);
    assert.throws(() => new win.DAGEditor(null), /HTMLElement/);
  });

  it('works without a callback', () => {
    const { win, container } = createEnv({ create: false });
    const editor = new win.DAGEditor(container);
    assert.doesNotThrow(() => editor.addNode('A', 0, 0));
  });

  it('builds a toolbar, a canvas and a hint bar inside the container', () => {
    const { container } = createEnv();
    assert.ok(container.querySelector('.dag-toolbar'));
    assert.ok(container.querySelector('svg.dag-svg'));
    assert.ok(container.querySelector('.dag-hint'));
    assert.equal(container.getAttribute('tabindex'), '0', 'focusable, so it can receive keyboard shortcuts');
    for (const action of ['add-node', 'del-selected', 'undo', 'redo', 'fit', 'layout']) {
      assert.ok(container.querySelector(`[data-action="${action}"]`), `toolbar button ${action}`);
    }
  });

  it('gives a container with no size a default width and height, but leaves a sized one alone', () => {
    const empty = createEnv({ width: 0, height: 0 });
    assert.equal(empty.container.style.height, '480px');
    assert.equal(empty.container.style.width, '100%');
    const sized = createEnv({ width: 600, height: 400 });
    assert.equal(sized.container.style.height, '', 'a container laid out by CSS keeps its height');
  });

  it('starts empty and unflipped', () => {
    const { editor } = createEnv();
    same(editor.getGraph(), { nodes: [], edges: [] });
    assert.equal(editor.flipped, false);
  });
});

describe('adding nodes', () => {
  let env, editor;
  beforeEach(() => { env = createEnv(); editor = env.editor; });

  it('creates a node with one input and one output port, at the position given', () => {
    const n = editor.addNode('Filter', 40, 50);
    assert.equal(n.label, 'Filter');
    same([n.x, n.y], [40, 50]);
    same(n.inputs, [{ id: 'in', label: '' }]);
    same(n.outputs, [{ id: 'out', label: '' }]);
  });

  it('accepts custom ports', () => {
    const n = editor.addNode('Join', 0, 0, { inputs: [port('a'), port('b')], outputs: [] });
    assert.equal(n.inputs.length, 2);
    assert.equal(n.outputs.length, 0);
  });

  it('numbers ids n1, n2, … and never reuses one', () => {
    const a = editor.addNode('A', 0, 0), b = editor.addNode('B', 0, 0);
    same([a.id, b.id], ['n1', 'n2']);
    editor.deleteNode('n2');
    assert.equal(editor.addNode('C', 0, 0).id, 'n3');
  });

  it('gives each unlabelled node a distinct name', () => {
    const labels = [editor.addNode(undefined, 0, 0), editor.addNode(undefined, 0, 0), editor.addNode(undefined, 0, 0)].map(n => n.label);
    same(labels, ['Node', 'Node 2', 'Node 3']);
    editor.deleteNode('n2');
    assert.equal(editor.addNode(undefined, 0, 0).label, 'Node 2', 'a freed name is reused');
  });

  it('does not force a label the caller chose to be unique', () => {
    editor.addNode('Same', 0, 0);
    assert.equal(editor.addNode('Same', 0, 0).label, 'Same');
  });

  it('puts a node with no position in the middle of the view', () => {
    const n = editor.addNode('Centre');
    const b = editor._boxOf(n);
    const cx = (editor._svgRect().width / 2 - editor._viewX) / editor._scale;
    const cy = (editor._svgRect().height / 2 - editor._viewY) / editor._scale;
    assert.ok(Math.abs(b.x + b.w / 2 - cx) < 1 && Math.abs(b.y + b.h / 2 - cy) < 1);
  });

  it('defaults a single missing coordinate', () => {
    const n = editor.addNode('Half', 123);
    assert.equal(n.x, 123);
    assert.ok(Number.isFinite(n.y));
  });

  it('selects the new node and tells the caller, selection first', () => {
    const n = editor.addNode('A', 0, 0);
    same(types(env.events), ['selected', 'created']);
    assert.equal(env.events[1].node, n, 'the event carries the live DAGNode');
    same(editor._selected, { kind: 'node', id: 'n1' });
  });

  it('creates nodes with the New node button and the N key', () => {
    env.container.querySelector('[data-action="add-node"]').click();
    env.key('n');
    env.key('N');
    assert.equal(editor.getGraph().nodes.length, 3);
    const spots = editor.getGraph().nodes.map(n => `${n.x},${n.y}`);
    assert.equal(new Set(spots).size, 3, 'successive nodes are offset so they do not stack');
  });
});

describe('adding edges', () => {
  let env, editor;
  beforeEach(() => {
    env = createEnv(); editor = env.editor;
    editor.loadGraph(graph([['a', 'A', 0, 0], ['b', 'B', 300, 0], ['c', 'C', 600, 0]]));
    env.events.length = 0;
  });

  it('connects an output port to an input port and reports it', () => {
    assert.equal(editor.addEdge('a', 'out', 'b', 'in'), true);
    const [e] = editor.getGraph().edges;
    same(e.toJSON(), { id: 'e1', fromNodeId: 'a', fromPortId: 'out', toNodeId: 'b', toPortId: 'in' });
    same(types(env.events), ['edge-created']);
    assert.equal(env.events[0].edge, e);
  });

  it('refuses a self-loop', () => {
    assert.equal(editor.addEdge('a', 'out', 'a', 'in'), false);
    assert.equal(editor.getGraph().edges.length, 0);
  });

  it('refuses an exact duplicate, but allows a second edge into the same input from elsewhere', () => {
    assert.equal(editor.addEdge('a', 'out', 'c', 'in'), true);
    assert.equal(editor.addEdge('a', 'out', 'c', 'in'), false);
    assert.equal(editor.addEdge('b', 'out', 'c', 'in'), true, 'fan-in on one port is fine');
    assert.equal(editor.getGraph().edges.length, 2);
  });

  it('refuses an edge that would make a cycle, directly or through other nodes', () => {
    editor.addEdge('a', 'out', 'b', 'in');
    editor.addEdge('b', 'out', 'c', 'in');
    assert.equal(editor.addEdge('b', 'out', 'a', 'in'), false, 'two-node cycle');
    assert.equal(editor.addEdge('c', 'out', 'a', 'in'), false, 'three-node cycle');
    assert.equal(editor.getGraph().edges.length, 2);
  });

  it('says why in the hint bar, and then puts the usual hint back', () => {
    editor.addEdge('a', 'out', 'b', 'in');
    editor.addEdge('b', 'out', 'a', 'in');
    const hint = env.container.querySelector('.dag-hint');
    assert.match(hint.textContent, /cycle/);
    env.runTimeouts();
    assert.doesNotMatch(hint.textContent, /cycle/);
  });

  it('fires no event for a refused edge', () => {
    editor.addEdge('a', 'out', 'a', 'in');
    same(env.events, []);
  });
});

describe('deleting', () => {
  let env, editor;
  beforeEach(() => {
    env = createEnv(); editor = env.editor;
    // a → m → c, a → c   (m has exactly one input and one output)
    editor.loadGraph(graph([['a', 'A', 0, 0], ['m', 'M', 300, 0], ['c', 'C', 600, 0]],
      [['e1', 'a', 'out', 'm', 'in'], ['e2', 'm', 'out', 'c', 'in']]));
    env.events.length = 0;
  });

  it('deleteEdge removes one edge and reports it', () => {
    editor.deleteEdge('e1');
    same(editor.getGraph().edges.map(e => e.id), ['e2']);
    same(types(env.events), ['edge-deleted']);
    assert.equal(env.events[0].edge.id, 'e1');
  });

  it('deleting a node removes its edges, reporting the edges first and then the node', () => {
    const m = editor.getGraph().nodes.find(n => n.id === 'm');
    editor.deleteNode('m');
    assert.equal(editor.getGraph().nodes.length, 2);
    same(types(env.events).slice(0, 3), ['edge-deleted', 'edge-deleted', 'deleted']);
    assert.equal(env.events.find(e => e.type === 'deleted').node, m);
  });

  it('bridges across a deleted node that has exactly one input and one output port', () => {
    editor.deleteNode('m');
    const [bridge] = editor.getGraph().edges;
    same([bridge.fromNodeId, bridge.fromPortId, bridge.toNodeId, bridge.toPortId], ['a', 'out', 'c', 'in']);
    same(types(env.events), ['edge-deleted', 'edge-deleted', 'deleted', 'edge-created']);
  });

  it('bridges every source to every target', () => {
    editor.loadGraph(graph([['s1', 'S1', 0, 0], ['s2', 'S2', 0, 100], ['m', 'M', 300, 50], ['t1', 'T1', 600, 0], ['t2', 'T2', 600, 100]],
      [['e1', 's1', 'out', 'm', 'in'], ['e2', 's2', 'out', 'm', 'in'], ['e3', 'm', 'out', 't1', 'in'], ['e4', 'm', 'out', 't2', 'in']]));
    editor.deleteNode('m');
    const pairs = editor.getGraph().edges.map(e => `${e.fromNodeId}>${e.toNodeId}`).sort();
    same(pairs, ['s1>t1', 's1>t2', 's2>t1', 's2>t2']);
  });

  it('does not bridge a node with several ports on a side', () => {
    editor.loadGraph(graph([['a', 'A', 0, 0], ['m', 'M', 300, 0, [port('i1'), port('i2')], [port('o')]], ['c', 'C', 600, 0]],
      [['e1', 'a', 'out', 'm', 'i1'], ['e2', 'm', 'o', 'c', 'in']]));
    editor.deleteNode('m');
    assert.equal(editor.getGraph().edges.length, 0);
  });

  it('skips a bridge that would duplicate an existing edge', () => {
    editor.addEdge('a', 'out', 'c', 'in');
    env.events.length = 0;
    editor.deleteNode('m');
    assert.equal(editor.getGraph().edges.length, 1);
    assert.ok(!types(env.events).includes('edge-created'));
  });

  it('ignores unknown ids', () => {
    editor.deleteNode('zzz'); editor.deleteEdge('zzz');
    assert.equal(editor.getGraph().nodes.length, 3);
    assert.equal(editor.getGraph().edges.length, 2);
  });

  it('Delete and Backspace remove the selection, and the toolbar button does too', () => {
    editor._setSelected('node', 'c');
    env.key('Delete');
    assert.ok(!editor.getGraph().nodes.some(n => n.id === 'c'));
    editor._setSelected('node', 'a');
    env.key('Backspace');
    assert.ok(!editor.getGraph().nodes.some(n => n.id === 'a'));
    editor.loadGraph(graph([['x', 'X', 0, 0]]));
    editor._setSelected('node', 'x');
    env.container.querySelector('[data-action="del-selected"]').click();
    assert.equal(editor.getGraph().nodes.length, 0);
  });

  it('Delete with nothing selected does nothing', () => {
    env.key('Delete');
    assert.equal(editor.getGraph().nodes.length, 3);
  });

  it('deleting the selected edge works', () => {
    editor._setSelected('edge', 'e2');
    env.key('Delete');
    same(editor.getGraph().edges.map(e => e.id), ['e1']);
  });
});

describe('selection', () => {
  let env, editor;
  beforeEach(() => {
    env = createEnv(); editor = env.editor;
    editor.loadGraph(graph([['a', 'A', 0, 0], ['b', 'B', 300, 0], ['c', 'C', 600, 0]], [['e1', 'a', 'out', 'b', 'in']]));
    env.events.length = 0;
  });

  it('selecting a node reports it, and moving to another reports the first as deselected', () => {
    editor._setSelected('node', 'a');
    editor._setSelected('node', 'b');
    same(types(env.events), ['selected', 'deselected', 'selected']);
    assert.equal(env.events[1].node.id, 'a');
  });

  it('re-selecting the same node reports selected again but not deselected', () => {
    editor._setSelected('node', 'a');
    editor._setSelected('node', 'a');
    same(types(env.events), ['selected', 'selected']);
  });

  it('selecting an edge deselects the node; Escape clears the selection', () => {
    editor._setSelected('node', 'a');
    editor._setSelected('edge', 'e1');
    same(types(env.events), ['selected', 'deselected']);
    editor._setSelected('node', 'b');
    env.key('Escape');
    assert.equal(editor._selected, null);
    assert.equal(types(env.events).at(-1), 'deselected');
  });

  it('marks the selected node and edge in the drawing', () => {
    editor._setSelected('node', 'a');
    assert.ok(env.nodeEl('a').classList.contains('dag-node--selected'));
    assert.ok(!env.nodeEl('b').classList.contains('dag-node--selected'));
    editor._setSelected('edge', 'e1');
    const path = env.document.querySelector('path[data-id="e1"]');
    assert.ok(path.classList.contains('dag-edge--selected'));
    assert.equal(path.getAttribute('marker-end'), 'url(#dag-arrow-sel)');
  });

  it('Tab and Shift+Tab cycle through the nodes, wrapping round', () => {
    env.key('Tab');   assert.equal(editor._selected.id, 'a');
    env.key('Tab');   assert.equal(editor._selected.id, 'b');
    env.key('Tab');   assert.equal(editor._selected.id, 'c');
    env.key('Tab');   assert.equal(editor._selected.id, 'a');
    env.key('Tab', { shiftKey: true }); assert.equal(editor._selected.id, 'c');
  });

  it('Tab on an empty graph does nothing', () => {
    editor.loadGraph({ version: 2, nodes: [], edges: [] });
    assert.doesNotThrow(() => env.key('Tab'));
  });

  it('ignores shortcut keys typed into a text field', () => {
    const input = env.document.createElement('input');
    env.container.appendChild(input); input.focus();
    editor._setSelected('node', 'a');
    env.key('Delete', { target: input });
    assert.equal(editor.getGraph().nodes.length, 3);
  });
});
