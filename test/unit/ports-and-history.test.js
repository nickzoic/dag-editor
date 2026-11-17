'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port, graph, same } = require('../helpers/jsdom-env');

const types = events => events.map(e => e.type);
const sample = () => graph(
  [['a', 'A', 0, 0, [], [port('o1'), port('o2')]], ['b', 'B', 300, 0, [port('i1'), port('i2')], [port('out')]], ['c', 'C', 600, 0]],
  [['e1', 'a', 'o1', 'b', 'i1'], ['e2', 'a', 'o2', 'b', 'i2'], ['e3', 'b', 'out', 'c', 'in']]);

describe('node labels', () => {
  let env, editor;
  beforeEach(() => { env = createEnv(); editor = env.editor; editor.loadGraph(sample()); env.events.length = 0; });

  it('setNodeLabel changes the label, redraws it and reports an update', () => {
    assert.equal(editor.setNodeLabel('a', 'Renamed'), true);
    assert.equal(editor.getGraph().nodes[0].label, 'Renamed');
    assert.equal(env.nodeEl('a').querySelector('.dag-node-label').textContent, 'Renamed');
    assert.deepEqual(types(env.events), ['updated']);
  });

  it('setNodeLabel with the same label is a quiet success', () => {
    assert.equal(editor.setNodeLabel('a', 'A'), true);
    assert.deepEqual(env.events, []);
  });

  it('setNodeLabel on an unknown node returns false', () => {
    assert.equal(editor.setNodeLabel('nope', 'x'), false);
  });

  it('coerces the label to a string', () => {
    editor.setNodeLabel('a', 42);
    assert.equal(editor.getGraph().nodes[0].label, '42');
  });

  it('wraps a long label onto several lines and makes the node taller', () => {
    const before = editor._nodeHeight(editor.getGraph().nodes[0]);
    editor.setNodeLabel('a', 'a rather long label that has to wrap');
    assert.ok(env.nodeEl('a').querySelectorAll('.dag-node-label tspan').length > 1);
    assert.ok(editor._nodeHeight(editor.getGraph().nodes[0]) > before);
  });
});

describe('addPort', () => {
  let env, editor;
  beforeEach(() => { env = createEnv(); editor = env.editor; editor.loadGraph(sample()); env.events.length = 0; });

  it('adds a port with a unique id and an empty label, and reports an update', () => {
    const p = editor.addPort('c', 'input');
    same(p, { id: 'in2', label: '' });
    assert.equal(editor.getGraph().nodes[2].inputs.length, 2);
    assert.deepEqual(types(env.events), ['updated']);
    assert.ok(env.portEl('c', 'in2', 'in'), 'and it is drawn');
  });

  it('numbers further ports in, in2, in3 … and out, out2 …', () => {
    editor.addPort('a', 'input'); editor.addPort('a', 'input');
    same(editor.getGraph().nodes[0].inputs.map(p => p.id), ['in', 'in2']);
    editor.addPort('c', 'output');
    same(editor.getGraph().nodes[2].outputs.map(p => p.id), ['out', 'out2']);
  });

  it('accepts an id and a label', () => {
    same(editor.addPort('a', 'output', { id: 'extra', label: 'E' }), { id: 'extra', label: 'E' });
    same(editor.addPort('a', 'output', { label: 7 }).label, '7');
  });

  it('refuses an id that is already used on that side, but allows it on the other', () => {
    assert.equal(editor.addPort('a', 'output', { id: 'o1' }), null);
    assert.ok(editor.addPort('a', 'input', { id: 'o1' }));
  });

  it('returns null for an unknown node and throws for a bad direction', () => {
    assert.equal(editor.addPort('nope', 'input'), null);
    assert.throws(() => editor.addPort('a', 'sideways'), /direction/);
  });

  it('a port added to a compact node keeps it compact while labels are short', () => {
    assert.equal(editor._isCompact(editor.getGraph().nodes[2]), true);
    editor.addPort('c', 'input');
    assert.equal(editor._isCompact(editor.getGraph().nodes[2]), true);
    assert.ok(env.nodeEl('c').classList.contains('dag-node--compact'));
  });
});

describe('removePort', () => {
  let env, editor;
  beforeEach(() => { env = createEnv(); editor = env.editor; editor.loadGraph(sample()); env.events.length = 0; });

  it('removes the port and every edge attached to it, reporting the edges first', () => {
    assert.equal(editor.removePort('a', 'output', 'o1'), true);
    same(editor.getGraph().nodes[0].outputs.map(p => p.id), ['o2']);
    same(editor.getGraph().edges.map(e => e.id), ['e2', 'e3']);
    assert.deepEqual(types(env.events), ['edge-deleted', 'updated']);
    assert.equal(env.events[0].edge.id, 'e1');
    assert.equal(env.portEl('a', 'o1', 'out'), null, 'the dot is gone');
  });

  it('removing an input port removes the edges arriving at it', () => {
    editor.removePort('b', 'input', 'i2');
    same(editor.getGraph().edges.map(e => e.id), ['e1', 'e3']);
  });

  it('removes all of the edges when a port has several', () => {
    editor.addEdge('a', 'o1', 'c', 'in');
    editor.addEdge('b', 'out', 'c', 'in');
    editor.removePort('c', 'input', 'in');
    assert.ok(editor.getGraph().edges.every(e => e.toNodeId !== 'c'));
  });

  it('removing a port without edges reports only the update', () => {
    editor.addPort('c', 'output');
    env.events.length = 0;
    editor.removePort('c', 'output', 'out2');
    assert.deepEqual(types(env.events), ['updated']);
  });

  it('clears the selection if the selected edge goes with the port', () => {
    editor._setSelected('edge', 'e1');
    editor.removePort('a', 'output', 'o1');
    assert.equal(editor._selected, null);
  });

  it('leaves another selected edge alone', () => {
    editor._setSelected('edge', 'e3');
    editor.removePort('a', 'output', 'o1');
    same(editor._selected, { kind: 'edge', id: 'e3' });
  });

  it('returns false for an unknown node or port, and throws for a bad direction', () => {
    assert.equal(editor.removePort('nope', 'input', 'x'), false);
    assert.equal(editor.removePort('a', 'output', 'nope'), false);
    assert.throws(() => editor.removePort('a', 'up', 'o1'), /direction/);
  });

  it('is undoable, restoring the port and its edges', () => {
    editor.removePort('a', 'output', 'o1');
    editor.undo();
    assert.equal(editor.getGraph().edges.length, 3);
    assert.equal(editor.getGraph().nodes[0].outputs.length, 2);
  });
});

describe('setPortLabel', () => {
  let env, editor;
  beforeEach(() => { env = createEnv(); editor = env.editor; editor.loadGraph(sample()); env.events.length = 0; });

  it('changes the label, redraws it and reports an update', () => {
    assert.equal(editor.setPortLabel('b', 'input', 'i1', 'x'), true);
    assert.equal(editor.getGraph().nodes[1].inputs[0].label, 'x');
    assert.deepEqual(types(env.events), ['updated']);
  });

  it('is a quiet success when nothing changes, and false for unknown targets', () => {
    assert.equal(editor.setPortLabel('b', 'input', 'i1', ''), true);
    assert.deepEqual(env.events, []);
    assert.equal(editor.setPortLabel('nope', 'input', 'i1', 'x'), false);
    assert.equal(editor.setPortLabel('b', 'input', 'nope', 'x'), false);
    assert.throws(() => editor.setPortLabel('b', 'left', 'i1', 'x'), /direction/);
  });

  it('a label longer than one character switches a node from compact to expanded, and back', () => {
    const b = () => editor.getGraph().nodes[1];
    assert.equal(editor._isCompact(b()), true);
    editor.setPortLabel('b', 'input', 'i1', 'abc');
    assert.equal(editor._isCompact(b()), false);
    assert.ok(!env.nodeEl('b').classList.contains('dag-node--compact'));
    editor.setPortLabel('b', 'input', 'i1', 'a');
    assert.equal(editor._isCompact(b()), true);
    assert.ok(env.nodeEl('b').classList.contains('dag-node--compact'));
  });
});

describe('undo and redo', () => {
  let env, editor;
  beforeEach(() => { env = createEnv(); editor = env.editor; });

  it('the first undo reverts the most recent change', () => {
    editor.addNode('A', 0, 0);
    editor.addNode('B', 100, 0);
    editor.undo();
    same(editor.getGraph().nodes.map(n => n.label), ['A']);
  });

  it('undoing everything returns to the empty graph, and then does nothing more', () => {
    editor.addNode('A', 0, 0); editor.addNode('B', 0, 0);
    editor.undo(); editor.undo();
    assert.equal(editor.getGraph().nodes.length, 0);
    editor.undo();
    assert.equal(editor.getGraph().nodes.length, 0);
  });

  it('redo puts a change back, and a new change makes redo impossible', () => {
    editor.addNode('A', 0, 0); editor.addNode('B', 0, 0);
    editor.undo();
    editor.redo();
    assert.equal(editor.getGraph().nodes.length, 2);
    editor.undo();
    editor.addNode('C', 0, 0);
    editor.redo();
    same(editor.getGraph().nodes.map(n => n.label), ['A', 'C']);
  });

  it('redo with nothing to redo does nothing', () => {
    editor.addNode('A', 0, 0);
    editor.redo();
    assert.equal(editor.getGraph().nodes.length, 1);
  });

  it('undoes and redoes edges, deletions and moves', () => {
    editor.loadGraph(graph([['a', 'A', 0, 0], ['b', 'B', 300, 0]]));
    editor.addEdge('a', 'out', 'b', 'in');
    editor.undo();
    assert.equal(editor.getGraph().edges.length, 0);
    editor.redo();
    assert.equal(editor.getGraph().edges.length, 1);
    editor.deleteNode('b');
    editor.undo();
    assert.equal(editor.getGraph().nodes.length, 2);
    assert.equal(editor.getGraph().edges.length, 1, 'and its edge comes back with it');
  });

  it('a burst of edits to one label is a single undo step', () => {
    editor.loadGraph(graph([['a', 'A', 0, 0]]));
    const depth = editor._undoStack.length;
    for (const v of ['V', 'Va', 'Val', 'Vali']) editor.setNodeLabel('a', v);
    assert.equal(editor._undoStack.length, depth + 1);
    editor.undo();
    assert.equal(editor.getGraph().nodes[0].label, 'A');
  });

  it('edits to different labels are separate steps', () => {
    editor.loadGraph(graph([['a', 'A', 0, 0], ['b', 'B', 0, 0]]));
    const depth = editor._undoStack.length;
    editor.setNodeLabel('a', 'A1'); editor.setNodeLabel('b', 'B1'); editor.setNodeLabel('a', 'A2');
    assert.equal(editor._undoStack.length, depth + 3);
  });

  it('a burst of edits to one port label is a single undo step', () => {
    editor.loadGraph(graph([['a', 'A', 0, 0]]));
    const depth = editor._undoStack.length;
    for (const v of ['x', 'xy', 'xyz']) editor.setPortLabel('a', 'input', 'in', v);
    assert.equal(editor._undoStack.length, depth + 1);
  });

  it('remembers at most 100 steps', () => {
    for (let i = 0; i < 130; i++) editor.addNode(`N${i}`, i, 0);
    assert.ok(editor._undoStack.length <= 100);
    for (let i = 0; i < 130; i++) editor.undo();
    assert.ok(editor.getGraph().nodes.length >= 30, 'the oldest changes can no longer be undone');
  });

  it('clears the selection, telling listeners the node was deselected', () => {
    editor.addNode('A', 0, 0); editor.addNode('B', 0, 0);
    env.events.length = 0;
    editor.undo();
    assert.equal(editor._selected, null);
    assert.deepEqual(types(env.events), ['deselected']);
  });

  it('is available from the toolbar and from the keyboard', () => {
    editor.addNode('A', 0, 0); editor.addNode('B', 0, 0); editor.addNode('C', 0, 0); editor.addNode('D', 0, 0);
    env.container.querySelector('[data-action="undo"]').click();
    assert.equal(editor.getGraph().nodes.length, 3);
    env.container.querySelector('[data-action="redo"]').click();
    assert.equal(editor.getGraph().nodes.length, 4);
    env.key('z', { ctrlKey: true });                       assert.equal(editor.getGraph().nodes.length, 3);
    env.key('Z', { ctrlKey: true, shiftKey: true });       assert.equal(editor.getGraph().nodes.length, 4);
    env.key('z', { metaKey: true });                       assert.equal(editor.getGraph().nodes.length, 3);
    env.key('y', { ctrlKey: true });                       assert.equal(editor.getGraph().nodes.length, 4);
  });
});
