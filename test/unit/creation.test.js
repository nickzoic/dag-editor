'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port, graph, same } = require('../helpers/jsdom-env');

describe('creating nodes', () => {
  let env, editor, svg;
  beforeEach(() => {
    env = createEnv({ width: 800, height: 500 }); editor = env.editor;
    editor.loadGraph(graph([['a', 'A', 100, 100, [], [port('out')]], ['b', 'B', 500, 100, [port('in')], []]]));
    svg = env.container.querySelector('svg.dag-svg');
  });
  const last = () => editor.getGraph().nodes.at(-1);
  const empty = () => env.client(-200, 400);
  const click = p => { env.mouse(svg, 'mousedown', p.x, p.y); env.mouse(svg, 'mouseup', p.x, p.y); };
  const portPoint = (id, dir, pid) => {
    const n = editor._nodes.get(id);
    const p = dir === 'out' ? editor._outputPortPos(n, pid) : editor._inputPortPos(n, pid);
    return env.client(p.x, p.y);
  };
  const drag = (from, to) => {
    env.mouse(svg, 'mousedown', from.x, from.y);
    env.mouse(svg, 'mousemove', (from.x + to.x) / 2, (from.y + to.y) / 2);
    env.mouse(svg, 'mousemove', to.x, to.y);
    env.mouse(svg, 'mouseup', to.x, to.y);
  };

  it('a click on empty canvas makes a node with no ports', () => {
    click(empty());
    assert.equal(editor.getGraph().nodes.length, 3);
    same([last().inputs.length, last().outputs.length], [0, 0]);
  });

  it('the N key and addNodeAtCentre make portless nodes too', () => {
    env.key('n'); editor.addNodeAtCentre();
    for (const n of editor.getGraph().nodes.slice(2)) same([n.inputs.length, n.outputs.length], [0, 0]);
  });

  it('dragging from an output onto empty canvas makes a node with exactly one input, joined to that output', () => {
    drag(portPoint('a', 'out', 'out'), empty());
    const n = last();
    same(n.inputs, [{ id: 'in', label: '' }]);
    same(n.outputs, []);
    same(editor.getGraph().edges.map(e => `${e.fromNodeId}.${e.fromPortId}>${e.toNodeId}.${e.toPortId}`), [`a.out>${n.id}.in`]);
  });

  it('dragging from an input onto empty canvas makes a node with exactly one output, joined to that input', () => {
    drag(portPoint('b', 'in', 'in'), empty());
    const n = last();
    same(n.inputs, []);
    same(n.outputs, [{ id: 'out', label: '' }]);
    same(editor.getGraph().edges.map(e => `${e.fromNodeId}.${e.fromPortId}>${e.toNodeId}.${e.toPortId}`), [`${n.id}.out>b.in`]);
  });

  it('the new node is reported before the edge that joins it', () => {
    const types = [];
    editor.onAddNode = () => types.push('node');
    editor.onAddEdge = () => types.push('edge');
    drag(portPoint('a', 'out', 'out'), empty());
    same(types, ['node', 'edge']);
  });

  it('a host can add ports to a new node straight away', () => {
    editor.onAddNode = node => { editor.addPort(node.id, 'output', { id: 'extra' }); };
    click(empty());
    same(last().outputs.map(p => p.id), ['extra']);
  });

  it('splicing a node into an edge gives it one input and one output, so it can join the edge', () => {
    editor.addEdge('a', 'out', 'b', 'in');
    const e = editor.getGraph().edges.find(x => x.fromNodeId === 'a');
    const m = editor._bezierAt(editor._edgeP1(e), editor._edgeP2(e), 0.5), p = env.client(m.x, m.y);
    env.mouse(svg, 'dblclick', p.x, p.y);
    const spliced = editor.getGraph().nodes.at(-1);
    same(spliced.inputs.map(x => x.id), ['in']);
    same(spliced.outputs.map(x => x.id), ['out']);
    assert.equal(editor.getGraph().edges.length, 2);
  });
});
