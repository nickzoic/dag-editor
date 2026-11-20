'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port, graph, same } = require('../helpers/jsdom-env');

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const W = 140, PR = 6;                       // node width, port radius

describe('compact or expanded', () => {
  let editor;
  beforeEach(() => { editor = createEnv().editor; });
  const node = (inputs, outputs) => editor.addNode('N', 0, 0, { inputs, outputs });

  it('a node with no ports, or ports with no labels, is compact however many ports it has', () => {
    assert.equal(editor._isCompact(node([], [])), true);
    assert.equal(editor._isCompact(node([port('a'), port('b'), port('c'), port('d')], [port('x'), port('y'), port('z')])), true);
  });

  it('one-character labels keep a node compact', () => {
    assert.equal(editor._isCompact(node([port('a', 'a'), port('b', 'b'), port('c', 'c')], [port('x', 'x')])), true);
  });

  it('a label of two or more characters makes it expanded, even with a single port', () => {
    assert.equal(editor._isCompact(node([port('a', 'ab')], [])), false);
    assert.equal(editor._isCompact(node([port('a', 'raw')], [port('o', 'tokens')])), false);
    assert.equal(editor._isCompact(node([], [port('o', 'x'), port('p', 'long')])), false);
  });

  it('the node\'s own label never counts', () => {
    const n = editor.addNode('A very long node label indeed', 0, 0);
    assert.equal(editor._isCompact(n), true);
  });
});

describe('node size', () => {
  let editor;
  beforeEach(() => { editor = createEnv().editor; });
  const node = (label, inputs, outputs) => editor.addNode(label, 0, 0, { inputs, outputs });

  it('a compact node is 46 px high', () => assert.equal(editor._nodeHeight(node('N', [port('i')], [port('o')])), 46));

  it('a compact node with many ports grows to hold them (22 px each, plus 16)', () => {
    assert.equal(editor._nodeHeight(node('N', [port('a'), port('b'), port('c')], [])), 3 * 22 + 16);
    assert.equal(editor._nodeHeight(node('N', [port('a'), port('b'), port('c'), port('d')], [port('o')])), 4 * 22 + 16);
  });

  it('an expanded node is the 32 px header, 22 px per port, and 8 px of padding', () => {
    assert.equal(editor._nodeHeight(node('N', [port('a', 'abc')], [])), 32 + 22 + 8);
    assert.equal(editor._nodeHeight(node('N', [port('a', 'abc'), port('b', 'x')], [port('o')])), 32 + 44 + 8);
  });

  it('a long label wraps and each extra line adds 16 px, in either layout', () => {
    // jsdom cannot measure text, so the editor estimates 7.2 px a character: 13 characters fit a compact line
    const compact = node('one two three four five six', [port('i')], [port('o')]);
    same(editor._labelLines(compact, false), ['one two three', 'four five six']);
    assert.equal(editor._nodeHeight(compact), 2 * 16 + 30);
    const expanded = node('one two three four five six seven eight', [port('i', 'ii')], []);
    assert.equal(editor._labelLines(expanded, false).length, 3);
    assert.equal(editor._nodeHeight(expanded), (32 + 2 * 16) + 22 + 8);
  });

  it('wraps at word boundaries, collapses runs of spaces, and breaks a word that cannot fit', () => {
    same(editor._wrapLabel('  spaced    out  ', 98), ['spaced out']);
    same(editor._wrapLabel('', 98), ['']);
    same(editor._wrapLabel('   ', 98), ['']);
    const pieces = editor._wrapLabel('Supercalifragilisticexpialidocious', 98);
    assert.equal(pieces.join(''), 'Supercalifragilisticexpialidocious');
    assert.ok(pieces.length >= 3 && pieces.every(p => p.length * 7.2 <= 98));
    same(editor._wrapLabel('aa bbbbbbbbbbbbbbbbbbbbbbbb c', 98).slice(0, 1), ['aa']);
    same(editor._wrapLabel('x'.repeat(5), 1), ['x', 'x', 'x', 'x', 'x'], 'even when nothing fits, it terminates');
  });

  it('caches wrapped lines, and recomputes when the label changes', () => {
    const n = node('hello', [port('i')], [port('o')]);
    assert.equal(editor._labelLines(n, false), editor._labelLines(n, false));
    const first = editor._labelLines(n, false);
    n.label = 'something else entirely different';
    assert.notEqual(editor._labelLines(n, false), first);
  });
});

describe('port positions (unflipped)', () => {
  let editor;
  beforeEach(() => { editor = createEnv().editor; });

  it('a lone port on a compact node is at mid-height; inputs on the left edge, outputs on the right', () => {
    const n = editor.addNode('N', 100, 50, { inputs: [port('in')], outputs: [port('out')] });
    same(editor._inputPortPos(n, 'in'), { x: 100, y: 50 + 23 });
    same(editor._outputPortPos(n, 'out'), { x: 100 + W, y: 50 + 23 });
  });

  it('several ports on a compact node are stacked 22 px apart, centred on the node', () => {
    const n = editor.addNode('N', 0, 0, { inputs: [port('a'), port('b'), port('c')], outputs: [] });
    const ys = ['a', 'b', 'c'].map(id => editor._inputPortPos(n, id).y);
    near(ys[1] - ys[0], 22); near(ys[2] - ys[1], 22);
    near((ys[0] + ys[2]) / 2, editor._nodeHeight(n) / 2);
  });

  it('on an expanded node the ports start below the header', () => {
    const n = editor.addNode('N', 0, 0, { inputs: [port('a', 'abc'), port('b', 'def')], outputs: [] });
    near(editor._inputPortPos(n, 'a').y, 32 + 11);
    near(editor._inputPortPos(n, 'b').y, 32 + 22 + 11);
  });

  it('unknown ports have no position; a node with no ports still has somewhere for an edge to attach', () => {
    const n = editor.addNode('N', 0, 0, { inputs: [], outputs: [] });
    assert.equal(editor._inputPortPos(n, 'zz'), null);
    assert.equal(editor._outputPortPos(n, 'zz'), null);
    same(editor._firstOutputPos(n), { x: W, y: 23 });
    same(editor._firstInputPos(n), { x: 0, y: 23 });
  });
});

describe('hit testing', () => {
  let env, editor;
  beforeEach(() => { env = createEnv(); editor = env.editor; editor.loadGraph(graph([['a', 'A', 100, 100], ['b', 'B', 500, 100]], [['e1', 'a', 'out', 'b', 'in']])); });

  it('knows whether a point is in a node', () => {
    const [a] = editor.getGraph().nodes;
    assert.equal(editor._nodeHitTest(a, 170, 123), true);
    assert.equal(editor._nodeHitTest(a, 99, 123), false);
    assert.equal(editor._nodeHitTest(a, 170, 100 + 46 + 1), false);
  });

  it('knows whether a point is on a port (12 px radius)', () => {
    const [a] = editor.getGraph().nodes;
    const p = editor._outputPortPos(a, 'out');
    assert.equal(editor._portHitTest(p, p.x + 8, p.y), true);
    assert.equal(editor._portHitTest(p, p.x + 13, p.y), false);
    assert.ok(!editor._portHitTest(null, 0, 0));
  });

  it('knows whether a point is on an edge (7 px either side of the curve)', () => {
    const [e] = editor.getGraph().edges;
    const mid = editor._bezierAt(editor._edgeP1(e), editor._edgeP2(e), 0.5);
    assert.equal(editor._edgeHitTest(e, mid.x, mid.y), true);
    assert.equal(editor._edgeHitTest(e, mid.x, mid.y + 20), false);
  });

  it('an edge with a missing node cannot be hit', () => {
    const e = new env.win.DAGEdge({ id: 'x', fromNodeId: 'zz', fromPortId: 'o', toNodeId: 'b', toPortId: 'in' });
    assert.equal(editor._edgeHitTest(e, 0, 0), false);
  });
});

describe('edge curves (unflipped)', () => {
  let editor;
  beforeEach(() => { editor = createEnv().editor; });

  it('a mostly-horizontal edge leaves and arrives horizontally, on the port surfaces', () => {
    const g = editor._edgeGeom({ x: 100, y: 100 }, { x: 400, y: 130 });
    near(g.sx, 100 + PR + 1); near(g.sy, 100);
    near(g.ex, 400 - PR - 1); near(g.ey, 130);
    assert.equal(g.cy1, g.sy); assert.equal(g.cy2, g.ey);
    assert.ok(g.cx1 > g.sx && g.cx2 < g.ex);
  });

  it('handles are about 35% of the horizontal distance, never under 30 px', () => {
    const wide = editor._edgeGeom({ x: 0, y: 0 }, { x: 1000, y: 10 });
    near(wide.cx1 - wide.sx, 0.35 * 1000);          // 35% of the distance between the port centres
    const near2 = editor._edgeGeom({ x: 0, y: 0 }, { x: 60, y: 5 });
    near(near2.cx1 - near2.sx, 30);
  });

  it('a mostly-vertical edge leaves and arrives at 45°', () => {
    const down = editor._edgeGeom({ x: 100, y: 0 }, { x: 140, y: 400 });
    near(down.cx1 - down.sx, down.cy1 - down.sy);
    near(down.ex - down.cx2, down.ey - down.cy2);
    assert.ok(down.cy1 > down.sy);
    const up = editor._edgeGeom({ x: 100, y: 400 }, { x: 140, y: 0 });
    assert.ok(up.cy1 < up.sy, 'and heads upward when the target is above');
  });

  it('draws as an SVG cubic with an arrowhead', () => {
    editor.loadGraph(graph([['a', 'A', 0, 0], ['b', 'B', 300, 0]], [['e1', 'a', 'out', 'b', 'in']]));
    const path = editor._svg.querySelector('path[data-id="e1"]');
    assert.match(path.getAttribute('d'), /^M[-\d.]+,[-\d.]+ C[-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+$/);
    assert.equal(path.getAttribute('marker-end'), 'url(#dag-arrow)');
    assert.equal(path.getAttribute('fill'), 'none');
  });

  it('bezierAt runs from the start point to the end point', () => {
    const p1 = { x: 0, y: 0 }, p2 = { x: 300, y: 80 }, g = editor._edgeGeom(p1, p2);
    const s = editor._bezierAt(p1, p2, 0), e = editor._bezierAt(p1, p2, 1);
    near(s.x, g.sx); near(s.y, g.sy); near(e.x, g.ex); near(e.y, g.ey);
  });

  it('_edgeControlPoints exposes just the control points', () => {
    const g = editor._edgeGeom({ x: 0, y: 0 }, { x: 300, y: 80 }), c = editor._edgeControlPoints({ x: 0, y: 0 }, { x: 300, y: 80 });
    same(c, { cx1: g.cx1, cy1: g.cy1, cx2: g.cx2, cy2: g.cy2 });
  });
});
