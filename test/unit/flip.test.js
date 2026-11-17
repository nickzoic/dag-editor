'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port, graph, same } = require('../helpers/jsdom-env');

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const W = 140;

const diamond = () => graph([
  ['a', 'Source', 0, 0, [], [port('o', 'out'), port('p', 'p')]],
  ['b', 'Mid', 210, 0, [port('i'), port('j')], [port('o')]],
  ['c', 'Mid2', 210, 160, [port('i', 'x')], [port('o', 'y')]],
  ['d', 'Sink', 420, 80, [port('i', 'in'), port('j', 'k')], []],
], [['e1', 'a', 'o', 'b', 'i'], ['e2', 'a', 'p', 'c', 'i'], ['e3', 'b', 'o', 'd', 'i'], ['e4', 'c', 'o', 'd', 'j']]);

describe('choosing the orientation', () => {
  it('is unflipped for a wide container and flipped for a tall one', () => {
    assert.equal(createEnv({ width: 800, height: 500 }).editor.flipped, false);
    assert.equal(createEnv({ width: 400, height: 700 }).editor.flipped, true);
  });

  it('flips only when strictly taller than wide: a square is unflipped, one pixel taller is flipped', () => {
    assert.equal(createEnv({ width: 600, height: 600 }).editor.flipped, false);
    assert.equal(createEnv({ width: 600, height: 601 }).editor.flipped, true);
  });

  it('an empty, zero-sized container is unflipped', () => {
    assert.equal(createEnv({ width: 0, height: 0 }).editor.flipped, false);
  });

  it('marks the canvas so styles can tell', () => {
    const tall = createEnv({ width: 400, height: 700 });
    assert.ok(tall.container.querySelector('.dag-svg').classList.contains('dag-svg--flipped'));
    assert.ok(!createEnv().container.querySelector('.dag-svg').classList.contains('dag-svg--flipped'));
  });
});

describe('resizing', () => {
  let env, editor;
  beforeEach(() => { env = createEnv({ width: 800, height: 500 }); editor = env.editor; editor.loadGraph(diamond()); });

  const inside = () => {
    const r = editor._svgRect();
    return editor.getGraph().nodes.every(n => {
      const b = editor._boxOf(n);
      const x0 = editor._viewX + b.x * editor._scale, x1 = editor._viewX + (b.x + b.w) * editor._scale;
      const y0 = editor._viewY + b.y * editor._scale, y1 = editor._viewY + (b.y + b.h) * editor._scale;
      return x0 >= -0.5 && y0 >= -0.5 && x1 <= r.width + 0.5 && y1 <= r.height + 0.5;
    });
  };

  it('watches the container', () => assert.equal(env.observer.el, env.container));

  it('flips when the container becomes tall, and unflips when it becomes wide again', () => {
    env.resize(400, 800); assert.equal(editor.flipped, true);
    env.resize(800, 500); assert.equal(editor.flipped, false);
  });

  it('re-fits the graph to the new size each time, even when the orientation does not change', () => {
    assert.ok(inside());
    const before = [editor._scale, editor._viewX, editor._viewY].join();
    env.resize(400, 800); assert.ok(inside());
    env.resize(300, 900); assert.ok(inside());
    env.resize(900, 520); assert.ok(inside());
    assert.notEqual([editor._scale, editor._viewX, editor._viewY].join(), before);
  });

  it('never changes any node position, or the exported data', () => {
    const before = editor.exportJSON();
    env.resize(400, 800); env.resize(800, 500); env.resize(500, 900);
    assert.equal(editor.exportJSON(), before);
  });

  it('a resize with no nodes is harmless', () => {
    editor.loadGraph({ version: 2, nodes: [], edges: [] });
    assert.doesNotThrow(() => env.resize(400, 800));
    assert.equal(editor.flipped, true);
  });

  it('stops watching when destroyed', () => {
    editor.destroy();
    assert.equal(env.observer.disconnected, true);
    assert.equal(env.container.innerHTML, '');
  });

  it('falls back to window resizes where ResizeObserver does not exist', () => {
    const e = createEnv({ width: 400, height: 700, resizeObserver: false });
    assert.equal(e.editor.flipped, true);
    e.editor.loadGraph(diamond());
    e.resize(800, 500);
    assert.equal(e.editor.flipped, false);
    e.editor.destroy();
    e.resize(400, 800);                                   // no longer listening
    assert.equal(e.editor.flipped, false);
  });
});

describe('where flipped nodes go', () => {
  let env, editor, nodes;
  beforeEach(() => {
    env = createEnv({ width: 400, height: 700 }); editor = env.editor; editor.loadGraph(diamond());
    nodes = Object.fromEntries(editor.getGraph().nodes.map(n => [n.id, n]));
  });

  it('draws each node centred on the transposed centre of its unflipped box', () => {
    for (const n of Object.values(nodes)) {
      const b = editor._boxOf(n), hu = editor._nodeHeight(n);
      near(b.x + b.w / 2, n.y + hu / 2);
      near(b.y + b.h / 2, n.x + W / 2);
    }
  });

  it('keeps nodes in the same positions relative to each other', () => {
    // a node that is left of another unflipped is above it flipped, and vice versa
    const c = id => { const b = editor._boxOf(nodes[id]); return [b.x + b.w / 2, b.y + b.h / 2]; };
    assert.ok(c('a')[1] < c('b')[1] && c('b')[1] < c('d')[1], 'strata run top to bottom');
    assert.ok(c('b')[0] < c('c')[0], 'b is above c unflipped (lower y), so it is left of c flipped');
  });

  it('puts inputs on the top edge and outputs on the bottom edge', () => {
    for (const n of Object.values(nodes)) {
      const b = editor._boxOf(n);
      for (const p of n.inputs)  near(editor._inputPortPos(n, p.id).y, b.y);
      for (const p of n.outputs) near(editor._outputPortPos(n, p.id).y, b.y + b.h);
    }
  });

  it('keeps every port within the width of its node', () => {
    for (const n of Object.values(nodes)) {
      const b = editor._boxOf(n);
      for (const q of [...n.inputs.map(p => editor._inputPortPos(n, p.id)), ...n.outputs.map(p => editor._outputPortPos(n, p.id))]) {
        assert.ok(q.x >= b.x + 6 && q.x <= b.x + b.w - 6);
      }
    }
  });

  it('puts a lone port on a compact node in the middle, where its unflipped y puts it', () => {
    const c = nodes.c, port0 = editor._inputPortPos(c, 'i');
    near(port0.x, c.y + editor._portLocalY(c, 'input', 0));
  });

  it('a node with no ports still has attachment points: top-centre and bottom-centre', () => {
    const n = editor.addNode('Bare', 0, 0, { inputs: [], outputs: [] }), b = editor._boxOf(n);
    same(editor._firstInputPos(n), { x: b.x + b.w / 2, y: b.y });
    same(editor._firstOutputPos(n), { x: b.x + b.w / 2, y: b.y + b.h });
  });

  it('hit-tests the flipped box, and the flipped curve', () => {
    const b = editor._boxOf(nodes.b);
    assert.equal(editor._nodeHitTest(nodes.b, b.x + b.w / 2, b.y + b.h / 2), true);
    assert.equal(editor._nodeHitTest(nodes.b, b.x - 5, b.y + b.h / 2), false);
    assert.equal(editor._nodeHitTest(nodes.b, b.x + b.w / 2, b.y + b.h + 5), false);
    const [e] = editor.getGraph().edges, m = editor._bezierAt(editor._edgeP1(e), editor._edgeP2(e), 0.5);
    assert.equal(editor._edgeHitTest(e, m.x, m.y), true);
  });
});

describe('ports spread evenly along the edge', () => {
  let editor;
  beforeEach(() => { editor = createEnv({ width: 400, height: 700 }).editor; });
  const geom = (inputs, outputs) => editor._flipGeom(editor.addNode('F', 0, 0, { inputs, outputs }));
  const frac = (g, xs) => xs.map(x => x / g.w);

  it('one port in the middle, two at thirds, three at quarters, whatever their labels', () => {
    const one = geom([port('a', 'a long label')], [port('o')]);
    near(one.inX[0], one.w / 2); near(one.outX[0], one.w / 2);
    const two = geom([port('a', 'x'), port('b', 'x')], []);
    near(frac(two, two.inX)[0], 1 / 3); near(frac(two, two.inX)[1], 2 / 3);
    const three = geom([port('a', 'records'), port('b', 'a'), port('c', 'enriched')], []);
    same(frac(three, three.inX).map(f => Math.round(f * 1e6) / 1e6), [0.25, 0.5, 0.75]);
  });

  it('spaces the top and the bottom independently', () => {
    const g = geom([port('a'), port('b'), port('c')], [port('o'), port('p')]);
    near(g.inX[1] - g.inX[0], g.w / 4);
    near(g.outX[1] - g.outX[0], g.w / 3);
  });

  it('keeps the 120 px minimum width when labels are short', () => {
    const g = geom([port('a', 'a'), port('b', 'b'), port('c', 'c')], [port('o', 'out')]);
    assert.equal(g.w, 120);
    same(g.inX, [30, 60, 90]);
    same(g.outX, [60]);
  });

  it('widens the node so that the widest label fits in its spacing', () => {
    const g = geom([port('a', 'records'), port('b', 'ok'), port('c')], [port('o', 'enriched'), port('p', 'x')]);
    const tw = l => editor._portTextWidth(l);
    assert.ok(g.w > 120);
    assert.ok(g.inX[1] - g.inX[0] >= tw('records') + 10 - 1e-6);
    assert.ok(g.outX[1] - g.outX[0] >= tw('enriched') + 10 - 1e-6);
    near(g.w, Math.max(4 * (tw('records') + 10), 3 * (tw('enriched') + 10)));
  });

  it('never leaves a label hanging outside the node', () => {
    const g = geom([port('a', 'validation'), port('b', 'x')], []);
    const half = editor._portTextWidth('validation') / 2;
    assert.ok(g.inX.every(x => x - half >= -1e-6 && x + half <= g.w + 1e-6));
  });

  it('is at least as tall as the minimum, and a wrapped label makes it taller', () => {
    assert.ok(geom([port('a')], [port('o')]).h >= 46);
    const tall = editor._flipGeom(editor.addNode('a label long enough to need several lines of text', 0, 0));
    assert.ok(tall.h > 60);
  });

  it('caches the geometry until a label changes', () => {
    const n = editor.addNode('N', 0, 0, { inputs: [port('a', 'ab')], outputs: [] });
    const first = editor._flipGeom(n);
    assert.equal(editor._flipGeom(n), first);
    editor.setPortLabel(n.id, 'input', 'a', 'a much longer label');
    assert.notEqual(editor._flipGeom(n), first);
  });
});

describe('drawing flipped nodes', () => {
  let env, editor;
  beforeEach(() => { env = createEnv({ width: 400, height: 700 }); editor = env.editor; editor.loadGraph(diamond()); });

  it('places each node group at its flipped box', () => {
    for (const n of editor.getGraph().nodes) {
      const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(env.nodeEl(n.id).getAttribute('transform'));
      const b = editor._boxOf(n);
      near(+m[1], b.x); near(+m[2], b.y);
    }
  });

  it('draws input dots on the top edge and output dots on the bottom edge', () => {
    assert.equal(+env.portEl('d', 'i', 'in').getAttribute('cy'), 0);
    assert.equal(+env.portEl('a', 'o', 'out').getAttribute('cy'), editor._boxOf(editor.getGraph().nodes[0]).h);
  });

  it('keeps every label upright, centred on its port', () => {
    for (const t of env.container.querySelectorAll('.dag-node text.dag-port-label')) {
      assert.equal(t.getAttribute('transform'), null);
      assert.equal(t.getAttribute('text-anchor'), 'middle');
    }
    const lbl = env.nodeEl('d').querySelector('text[data-port-uid="label:i:in"]');
    assert.equal(lbl.getAttribute('x'), env.portEl('d', 'i', 'in').getAttribute('cx'));
  });

  it('puts the node label between the port-label rows', () => {
    const n = editor.getGraph().nodes.find(n => n.id === 'd');
    const f = editor._flipGeom(n);
    const ys = [...env.nodeEl('d').querySelectorAll('.dag-node-label tspan')].map(t => +t.getAttribute('y'));
    assert.ok(ys.every(y => y > f.top && y < editor._boxOf(n).h - f.bottom));
  });

  it('gives an expanded node a divider for each side that has ports', () => {
    const shown = id => [...env.nodeEl(id).querySelectorAll('line.dag-node-divider')].filter(l => l.style.display !== 'none').length;
    assert.equal(shown('d'), 1, 'inputs only');
    editor.setPortLabel('a', 'output', 'o', 'output');
    assert.equal(shown('a'), 1);
    editor.addPort('d', 'output', { label: 'longer' });
    assert.equal(shown('d'), 2, 'inputs and outputs');
    assert.equal(shown('c'), 0, 'compact nodes have none');
  });

  it('returns to the usual drawing when the container becomes wide', () => {
    env.resize(800, 500);
    assert.equal(+env.portEl('d', 'i', 'in').getAttribute('cx'), 0, 'inputs on the left edge again');
    const lbl = env.nodeEl('d').querySelector('text[data-port-uid="label:i:in"]');
    assert.equal(lbl.getAttribute('text-anchor'), 'start');
  });

  it('draws edges heading downward, with the arrowhead on the input end', () => {
    const [e] = editor.getGraph().edges, p1 = editor._edgeP1(e), p2 = editor._edgeP2(e);
    const g = editor._edgeGeom(p1, p2);
    assert.ok(g.sy > p1.y, 'leaves below the output port');
    assert.ok(g.ey < p2.y, 'ends above the input port');
    near(g.sx, p1.x);
    assert.ok(g.cy1 > g.sy && g.cy2 < g.ey);
  });

  it('is the same curve as unflipped, with the axes swapped', () => {
    const p1 = { x: 100, y: 40 }, p2 = { x: 160, y: 300 };
    const flipped = editor._edgeGeom(p1, p2);
    editor._flipped = false;
    const h = editor._edgeGeom({ x: p1.y, y: p1.x }, { x: p2.y, y: p2.x });
    near(flipped.sx, h.sy); near(flipped.sy, h.sx); near(flipped.cx1, h.cy1); near(flipped.cy1, h.cx1); near(flipped.ex, h.ey); near(flipped.ey, h.ex);
  });

  it('a mostly-sideways edge still leaves at 45°', () => {
    const g = editor._edgeGeom({ x: 0, y: 0 }, { x: 400, y: 100 });
    near(g.cx1 - g.sx, g.cy1 - g.sy);
  });

  it('measures drag anchors along the direction of flow', () => {
    same(editor._portSurface({ x: 50, y: 60 }, 'output'), { x: 50, y: 66 });
    same(editor._portSurface({ x: 50, y: 60 }, 'input'), { x: 50, y: 54 });
    editor._flipped = false;
    same(editor._portSurface({ x: 50, y: 60 }, 'output'), { x: 56, y: 60 });
    same(editor._portSurface({ x: 50, y: 60 }, 'input'), { x: 44, y: 60 });
  });
});

describe('positions stay in the unflipped orientation', () => {
  it('creating a node at a display point puts its centre there, with transposed model coordinates', () => {
    const { editor } = createEnv({ width: 400, height: 700 });
    const n = editor._createNodeAtDisplay(300, 120), b = editor._boxOf(n);
    near(b.x + b.w / 2, 300); near(b.y + b.h / 2, 120);
    near(n.x, 120 - W / 2); near(n.y, 300 - editor._nodeHeight(n) / 2);
  });

  it('unflipped, creation is the plain centre', () => {
    const { editor } = createEnv();
    const n = editor._createNodeAtDisplay(300, 120);
    near(n.x, 300 - W / 2); near(n.y, 120 - editor._nodeHeight(n) / 2);
  });

  it('addNode(label, x, y) takes unflipped coordinates, flipped or not', () => {
    for (const [w, h] of [[800, 500], [400, 700]]) {
      const n = createEnv({ width: w, height: h }).editor.addNode('P', 11, 22);
      assert.deepEqual([n.x, n.y], [11, 22]);
    }
  });

  it('addNode with no position lands in the middle of what is shown, flipped too', () => {
    const { editor } = createEnv({ width: 400, height: 700 });
    const n = editor.addNode('C'), b = editor._boxOf(n);
    near(b.x + b.w / 2, (editor._svgRect().width / 2 - editor._viewX) / editor._scale, 1);
    near(b.y + b.h / 2, (editor._svgRect().height / 2 - editor._viewY) / editor._scale, 1);
  });

  it('the export is identical whichever way up the editor is shown', () => {
    const wide = createEnv({ width: 800, height: 500 }).editor, tall = createEnv({ width: 400, height: 700 }).editor;
    wide.loadGraph(diamond()); tall.loadGraph(diamond());
    assert.equal(tall.exportJSON(), wide.exportJSON());
    const reloaded = createEnv({ width: 800, height: 500 }).editor;
    reloaded.importJSON(tall.exportJSON());
    assert.equal(reloaded.exportJSON(), tall.exportJSON());
  });
});
