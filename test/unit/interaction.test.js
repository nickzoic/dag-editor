'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port, graph, same } = require('../helpers/jsdom-env');

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const types = events => events.map(e => e.type);

/** An editor with three nodes, and helpers to point at things by id. */
function setup(width, height) {
  const env = createEnv({ width, height });
  const { editor } = env;
  editor.loadGraph(graph([['a', 'A', 100, 100], ['b', 'B', 500, 100], ['c', 'C', 500, 320]]));
  env.events.length = 0;
  const svg = env.container.querySelector('svg.dag-svg');
  const node = id => editor._nodes.get(id);
  Object.assign(env, {
    svg,
    centre(id) { const b = editor._boxOf(node(id)); return env.client(b.x + b.w / 2, b.y + b.h / 2); },
    portAt(id, dir, pid) { const n = node(id); const p = dir === 'out' ? editor._outputPortPos(n, pid) : editor._inputPortPos(n, pid); return env.client(p.x, p.y); },
    /** Where empty canvas is: a spot well away from every node. */
    empty() { return env.client(-200, -200); },
    down: (p, init) => env.mouse(svg, 'mousedown', p.x, p.y, init),
    move: (p, init) => env.mouse(svg, 'mousemove', p.x, p.y, init),
    up:   (p, init) => env.mouse(svg, 'mouseup', p.x, p.y, init),
    drag(from, to, init) { env.down(from, init); env.move({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, init); env.move(to, init); env.up(to, init); },
    draftShown: () => svg.querySelector('.dag-edge-draft').style.display !== 'none',
  });
  return env;
}

for (const [name, w, h] of [['landscape', 800, 500], ['portrait (flipped)', 400, 700]]) {
  describe(`mouse: ${name}`, () => {
    let env, editor;
    beforeEach(() => { env = setup(w, h); editor = env.editor; });

    it('clicking empty canvas creates a node centred on the click', () => {
      const p = env.empty();
      env.down(p); env.up(p);
      assert.equal(editor.getGraph().nodes.length, 4);
      const n = editor.getGraph().nodes[3], b = editor._boxOf(n), c = env.client(b.x + b.w / 2, b.y + b.h / 2);
      near(c.x, p.x, 0.01); near(c.y, p.y, 0.01);
      same(types(env.events), ['selected', 'created']);
    });

    it('ignores the right and middle buttons', () => {
      env.down(env.empty(), { button: 2 });
      env.down(env.empty(), { button: 1 });
      assert.equal(editor.getGraph().nodes.length, 3);
    });

    it('clicking a node selects it, and clicking empty canvas then creates a node (and deselects)', () => {
      env.down(env.centre('a')); env.up(env.centre('a'));
      same(editor._selected, { kind: 'node', id: 'a' });
      same(types(env.events), ['selected']);
    });

    it('dragging a node moves it, following the pointer', () => {
      const before = env.centre('a'), n = editor._nodes.get('a'), x0 = n.x, y0 = n.y, s = editor._scale;
      env.drag(before, { x: before.x + 40, y: before.y + 70 });
      const after = env.centre('a');
      near(after.x - before.x, 40, 0.01); near(after.y - before.y, 70, 0.01);
      // the model moves transposed when flipped: screen-down is model-x
      if (editor.flipped) { near(n.x - x0, 70 / s, 0.01); near(n.y - y0, 40 / s, 0.01); }
      else { near(n.x - x0, 40 / s, 0.01); near(n.y - y0, 70 / s, 0.01); }
    });

    it('a drag is one undo step', () => {
      const n = editor._nodes.get('a'), x0 = n.x, y0 = n.y, p = env.centre('a');
      env.drag(p, { x: p.x + 50, y: p.y + 50 });
      editor.undo();
      near(editor._nodes.get('a').x, x0); near(editor._nodes.get('a').y, y0);
    });

    it('shows a crosshair over a port, and nothing elsewhere', () => {
      env.move(env.portAt('a', 'out', 'out'));
      assert.equal(env.svg.style.cursor, 'crosshair');
      env.move(env.portAt('b', 'in', 'in'));
      assert.equal(env.svg.style.cursor, 'crosshair');
      env.move(env.empty());
      assert.equal(env.svg.style.cursor, '');
    });

    it('dragging from an output port onto an input port connects them, showing a draft line meanwhile', () => {
      const from = env.portAt('a', 'out', 'out'), to = env.portAt('b', 'in', 'in');
      env.down(from);
      assert.equal(env.draftShown(), true);
      env.move({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
      env.move(to);
      assert.ok(env.portEl('b', 'in', 'in').classList.contains('dag-port--target'), 'the port it would connect to lights up');
      assert.ok(!env.portEl('c', 'in', 'in').classList.contains('dag-port--target'));
      env.up(to);
      assert.equal(env.draftShown(), false);
      assert.ok(!env.portEl('b', 'in', 'in').classList.contains('dag-port--target'));
      same(editor.getGraph().edges.map(e => `${e.fromNodeId}>${e.toNodeId}`), ['a>b']);
      same(types(env.events), ['edge-created']);
    });

    it('dropping on the body of a node connects to its first input', () => {
      env.drag(env.portAt('a', 'out', 'out'), env.centre('b'));
      same(editor.getGraph().edges.map(e => `${e.fromNodeId}.${e.fromPortId}>${e.toNodeId}.${e.toPortId}`), ['a.out>b.in']);
    });

    it('dropping on empty canvas creates a new node there and connects it', () => {
      const p = env.empty();
      env.drag(env.portAt('a', 'out', 'out'), p);
      assert.equal(editor.getGraph().nodes.length, 4);
      const nn = editor.getGraph().nodes[3], b = editor._boxOf(nn), c = env.client(b.x + b.w / 2, b.y + b.h / 2);
      near(c.x, p.x, 0.01); near(c.y, p.y, 0.01);
      same(editor.getGraph().edges.map(e => `${e.fromNodeId}>${e.toNodeId}`), [`a>${nn.id}`]);
    });

    it('dragging from an input port works the other way round', () => {
      env.drag(env.portAt('b', 'in', 'in'), env.portAt('a', 'out', 'out'));
      same(editor.getGraph().edges.map(e => `${e.fromNodeId}>${e.toNodeId}`), ['a>b']);
      editor.deleteEdge('e1');
      env.drag(env.portAt('b', 'in', 'in'), env.centre('a'));
      same(editor.getGraph().edges.map(e => `${e.fromNodeId}>${e.toNodeId}`), ['a>b'], 'onto the body of a node');
      editor.deleteEdge('e2');
      const p = env.empty();
      env.drag(env.portAt('b', 'in', 'in'), p);
      const nn = editor.getGraph().nodes[3];
      same(editor.getGraph().edges.map(e => `${e.fromNodeId}>${e.toNodeId}`), [`${nn.id}>b`], 'onto empty canvas: a new source node');
      assert.ok(env.portEl('a', 'out', 'out'));
    });

    it('lights up output ports as targets when dragging back from an input', () => {
      env.down(env.portAt('b', 'in', 'in'));
      env.move(env.portAt('a', 'out', 'out'));
      assert.ok(env.portEl('a', 'out', 'out').classList.contains('dag-port--target'));
      env.up(env.portAt('a', 'out', 'out'));
      assert.ok(!env.portEl('a', 'out', 'out').classList.contains('dag-port--target'));
    });

    it('refuses to complete a cycle, and says so', () => {
      editor.addEdge('a', 'out', 'b', 'in');
      env.events.length = 0;
      env.drag(env.portAt('b', 'out', 'out'), env.portAt('a', 'in', 'in'));
      assert.equal(editor.getGraph().edges.length, 1);
      assert.match(env.container.querySelector('.dag-hint').textContent, /cycle/);
    });

    it('moving the pointer out of the editor abandons an edge being drawn, or a node being dragged', () => {
      env.down(env.portAt('a', 'out', 'out'));
      env.mouse(env.svg, 'mouseleave');
      assert.equal(env.draftShown(), false);
      env.up(env.empty());
      assert.equal(editor.getGraph().edges.length, 0);
      env.down(env.centre('a'));
      env.mouse(env.svg, 'mouseleave');
      assert.equal(editor._dragging, null);
    });

    it('clicking an edge selects it', () => {
      editor.addEdge('a', 'out', 'b', 'in');
      env.events.length = 0;
      const e = editor.getGraph().edges[0], m = editor._bezierAt(editor._edgeP1(e), editor._edgeP2(e), 0.5), p = env.client(m.x, m.y);
      env.down(p); env.up(p);
      same(editor._selected, { kind: 'edge', id: e.id });
      assert.equal(editor.getGraph().nodes.length, 3, 'and no node is created');
    });

    it('double-clicking an edge splices a new node into it', () => {
      editor.addEdge('a', 'out', 'b', 'in');
      env.events.length = 0;
      const e = editor.getGraph().edges[0], m = editor._bezierAt(editor._edgeP1(e), editor._edgeP2(e), 0.5), p = env.client(m.x, m.y);
      env.mouse(env.svg, 'dblclick', p.x, p.y, { detail: 2 });
      const nodes = editor.getGraph().nodes;
      assert.equal(nodes.length, 4);
      const mid = nodes[3].id;
      same(editor.getGraph().edges.map(x => `${x.fromNodeId}>${x.toNodeId}`).sort(), [`a>${mid}`, `${mid}>b`].sort());
      same(types(env.events), ['selected', 'created', 'edge-deleted', 'edge-created', 'edge-created']);
      const b = editor._boxOf(nodes[3]), c = env.client(b.x + b.w / 2, b.y + b.h / 2);
      near(c.x, p.x, 0.01); near(c.y, p.y, 0.01);
    });

    it('double-clicking anywhere else does nothing', () => {
      const nodeCount = editor.getGraph().nodes.length;
      env.mouse(env.svg, 'dblclick', env.empty().x, env.empty().y);
      const c = env.centre('a');
      env.mouse(env.svg, 'dblclick', c.x, c.y);
      assert.equal(editor.getGraph().nodes.length, nodeCount);
      assert.equal(env.container.querySelector('input'), null, 'there is no inline rename box');
    });
  });
}

describe('view: zoom, pan and fit', () => {
  let env, editor;
  beforeEach(() => { env = setup(800, 500); editor = env.editor; });
  const wheel = (deltaY, x = 200, y = 150) => {
    const ev = new env.win.WheelEvent('wheel', { deltaY, clientX: x, clientY: y, bubbles: true, cancelable: true });
    env.svg.dispatchEvent(ev); return ev;
  };

  it('the wheel zooms in by 10% and out by 10% a notch, without scrolling the page', () => {
    const s = editor._scale;
    const ev = wheel(-100);
    assert.equal(ev.defaultPrevented, true);
    near(editor._scale, s * 1.1);
    wheel(100); near(editor._scale, s * 1.1 * 0.9, 1e-9);
  });

  it('keeps the point under the pointer where it was', () => {
    const before = editor._clientToGraph(200, 150);
    wheel(-100, 200, 150); wheel(-100, 200, 150);
    const after = editor._clientToGraph(200, 150);
    near(after.x, before.x, 1e-6); near(after.y, before.y, 1e-6);
  });

  it('stops zooming at 0.15× and 4×', () => {
    for (let i = 0; i < 80; i++) wheel(-100);
    assert.equal(editor._scale, 4);
    for (let i = 0; i < 160; i++) wheel(100);
    assert.equal(editor._scale, 0.15);
  });

  it('Alt + drag pans, and does not create a node', () => {
    const vx = editor._viewX, vy = editor._viewY, p = env.empty();
    env.down(p, { altKey: true });
    env.move({ x: p.x + 33, y: p.y - 21 });
    env.up({ x: p.x + 33, y: p.y - 21 });
    near(editor._viewX, vx + 33); near(editor._viewY, vy - 21);
    assert.equal(editor.getGraph().nodes.length, 3);
  });

  it('a pan ends when the pointer leaves', () => {
    env.down(env.empty(), { altKey: true });
    env.mouse(env.svg, 'mouseleave');
    assert.equal(editor._panning, null);
  });

  it('Fit scales and centres the whole graph in the view, whatever you have done to it', () => {
    const fitted = [editor._scale, editor._viewX, editor._viewY];
    for (let i = 0; i < 5; i++) wheel(-100);
    env.container.querySelector('[data-action="fit"]').click();
    near(editor._scale, fitted[0], 1e-9); near(editor._viewX, fitted[1], 1e-6); near(editor._viewY, fitted[2], 1e-6);
  });

  it('Fit on an empty graph does nothing', () => {
    editor.loadGraph({ version: 2, nodes: [], edges: [] });
    assert.doesNotThrow(() => env.container.querySelector('[data-action="fit"]').click());
  });

  it('fits a single node, scaling no larger than 2×', () => {
    editor.loadGraph(graph([['only', 'Only', 5, 5]]));
    assert.ok(editor._scale <= 2);
  });
});

describe('keyboard', () => {
  let env, editor;
  beforeEach(() => { env = setup(800, 500); editor = env.editor; });

  it('ignores keys it does not use', () => {
    for (const k of ['Enter', 'a', 'F5', ' ']) assert.doesNotThrow(() => env.key(k));
    assert.equal(editor.getGraph().nodes.length, 3);
  });

  it('gives the container focus when it is clicked, so the shortcuts work', () => {
    env.container.blur();
    const p = env.centre('a');
    env.down(p); env.up(p);
    assert.equal(env.document.activeElement, env.container);
  });

  it('a toolbar button gives the container focus back', () => {
    env.container.querySelector('[data-action="add-node"]').click();
    assert.equal(env.document.activeElement, env.container);
  });
});
