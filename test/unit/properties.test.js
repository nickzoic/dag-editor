'use strict';
/*
 * Randomised tests: apply long random sequences of edits (including undo/redo, resizing and auto-layout)
 * and check, after every step, the invariants that must always hold.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port, plain } = require('../helpers/jsdom-env');

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

const LABELS = ['', '', 'a', 'x', 'ok', 'in', 'records', 'enriched', 'validation_result', '😀', 'x\u0305', '<b>'];
const NAMES = ['A', 'Parse', 'Validate the incoming records', '', 'Supercalifragilisticexpialidocious', 'Merge results from every branch'];

/** Everything that must be true of the editor, whatever has been done to it. */
function checkInvariants(env, where, copy) {
  const { editor, document } = env;
  const { nodes, edges } = editor.getGraph();
  const byId = new Map(nodes.map(n => [n.id, n]));
  assert.equal(byId.size, nodes.length, `${where}: node ids are unique`);
  assert.equal(new Set(edges.map(e => e.id)).size, edges.length, `${where}: edge ids are unique`);
  const seen = new Set();
  for (const e of edges) {
    const from = byId.get(e.fromNodeId), to = byId.get(e.toNodeId);
    assert.ok(from && to, `${where}: edge ${e.id} joins existing nodes`);
    assert.ok(from.outputs.some(p => p.id === e.fromPortId), `${where}: edge ${e.id} leaves an existing output port`);
    assert.ok(to.inputs.some(p => p.id === e.toPortId), `${where}: edge ${e.id} enters an existing input port`);
    assert.notEqual(e.fromNodeId, e.toNodeId, `${where}: no self-loops`);
    const key = [e.fromNodeId, e.fromPortId, e.toNodeId, e.toPortId].join('|');
    assert.ok(!seen.has(key), `${where}: no duplicate edges`); seen.add(key);
  }
  // acyclic: peel off nodes with no remaining incoming edges
  const indeg = new Map(nodes.map(n => [n.id, 0]));
  for (const e of edges) indeg.set(e.toNodeId, indeg.get(e.toNodeId) + 1);
  const queue = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id); let removed = 0;
  while (queue.length) {
    const id = queue.pop(); removed++;
    for (const e of edges) if (e.fromNodeId === id && indeg.set(e.toNodeId, indeg.get(e.toNodeId) - 1).get(e.toNodeId) === 0) queue.push(e.toNodeId);
  }
  assert.equal(removed, nodes.length, `${where}: the graph is acyclic`);
  for (const n of nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${where}: node ${n.id} has finite coordinates`);
    assert.equal(new Set(n.inputs.map(p => p.id)).size, n.inputs.length, `${where}: input port ids are unique`);
    assert.equal(new Set(n.outputs.map(p => p.id)).size, n.outputs.length, `${where}: output port ids are unique`);
  }
  // the selection refers to something that exists
  const sel = editor._selected;
  if (sel) assert.ok(sel.kind === 'node' ? byId.has(sel.id) : edges.some(e => e.id === sel.id), `${where}: the selection exists`);
  // what is drawn matches the model
  assert.equal(document.querySelectorAll('.dag-node').length, nodes.length, `${where}: one drawn node per node`);
  assert.equal(document.querySelectorAll('path.dag-edge').length, edges.length, `${where}: one drawn edge per edge`);
  const dots = [...document.querySelectorAll('.dag-node circle.dag-port')].length;
  assert.equal(dots, nodes.reduce((s, n) => s + n.inputs.length + n.outputs.length, 0), `${where}: one dot per port`);
  // a copy made through JSON is identical
  copy.importJSON(editor.exportJSON());
  assert.equal(copy.exportJSON(), editor.exportJSON(), `${where}: export → import round-trips`);
}

function randomStep(env, r) {
  const { editor } = env;
  const pick = a => a[Math.floor(r() * a.length)];
  const { nodes, edges } = editor.getGraph();
  const ops = {
    addNode: () => editor.addNode(pick(NAMES), r() * 800, r() * 500, r() < 0.5 ? undefined : {
      inputs: Array.from({ length: Math.floor(r() * 4) }, (_, i) => port('i' + i, pick(LABELS))),
      outputs: Array.from({ length: Math.floor(r() * 4) }, (_, i) => port('o' + i, pick(LABELS))) }),
    addEdge: () => {
      const a = pick(nodes), b = pick(nodes);
      if (a && b && a.outputs.length && b.inputs.length) editor.addEdge(a.id, pick(a.outputs).id, b.id, pick(b.inputs).id);
    },
    deleteNode: () => nodes.length && editor.deleteNode(pick(nodes).id),
    deleteEdge: () => edges.length && editor.deleteEdge(pick(edges).id),
    addPort: () => nodes.length && editor.addPort(pick(nodes).id, pick(['input', 'output']), r() < 0.5 ? {} : { label: pick(LABELS) }),
    removePort: () => { const n = pick(nodes); if (n) { const d = pick(['input', 'output']); const ps = d === 'input' ? n.inputs : n.outputs; if (ps.length) editor.removePort(n.id, d, pick(ps).id); } },
    setPortLabel: () => { const n = pick(nodes); if (n) { const d = pick(['input', 'output']); const ps = d === 'input' ? n.inputs : n.outputs; if (ps.length) editor.setPortLabel(n.id, d, pick(ps).id, pick(LABELS)); } },
    setNodeLabel: () => nodes.length && editor.setNodeLabel(pick(nodes).id, pick(NAMES)),
    select: () => { if (nodes.length) editor._setSelected('node', pick(nodes).id); },
    selectEdge: () => { if (edges.length) editor._setSelected('edge', pick(edges).id); },
    undo: () => editor.undo(),
    redo: () => editor.redo(),
    layout: () => { editor.autoLayout(true); env.settle(); },
    resize: () => env.resize(...pick([[800, 500], [400, 700], [600, 600], [500, 900], [1000, 400]])),
    reload: () => editor.importJSON(editor.exportJSON()),
  };
  const name = pick(Object.keys(ops));
  ops[name]();
  return name;
}

describe('random sequences of edits', () => {
  for (let seed = 1; seed <= 24; seed++) {
    it(`seed ${seed}: the invariants hold after every step`, () => {
      const env = createEnv(), r = rng(seed * 7919);
      const copy = createEnv().editor;                 // one scratch editor for the round-trip check, reused
      const log = [];
      for (let i = 0; i < 70; i++) {
        let op;
        try { op = randomStep(env, r); } catch (e) { throw new Error(`step ${i} threw after [${log.slice(-6).join(', ')}]: ${e.stack}`); }
        log.push(op);
        try { checkInvariants(env, `step ${i} (${op})`, copy); } catch (e) { e.message += `\n   recent steps: ${log.slice(-8).join(', ')}`; throw e; }
      }
    });
  }
});

describe('random graphs laid out', () => {
  for (let seed = 1; seed <= 25; seed++) {
    it(`seed ${seed}: no overlaps in either orientation, deterministic, and stable when laid out again`, () => {
      const r = rng(seed * 104729), pick = a => a[Math.floor(r() * a.length)];
      const n = 2 + Math.floor(r() * 26), p = pick([0.05, 0.1, 0.18]);
      const nodes = Array.from({ length: n }, (_, i) => ({ id: 'n' + i, label: pick(NAMES), x: r() * 900, y: r() * 600,
        inputs: Array.from({ length: Math.floor(r() * 5) }, (_, k) => port('i' + k, pick(LABELS))),
        outputs: Array.from({ length: Math.floor(r() * 5) }, (_, k) => port('o' + k, pick(LABELS))) }));
      const edges = []; let k = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        if (r() < p && nodes[i].outputs.length && nodes[j].inputs.length) {
          edges.push({ id: 'e' + k++, fromNodeId: nodes[i].id, fromPortId: pick(nodes[i].outputs).id, toNodeId: nodes[j].id, toPortId: pick(nodes[j].inputs).id });
        }
      }
      const data = { version: 2, nodes, edges };
      const a = createEnv().editor; a.loadGraph(plain(data));
      const T = a._computeLayoutTargets();
      const b = createEnv().editor; b.loadGraph(plain(data));
      for (const [id, t] of b._computeLayoutTargets()) { assert.equal(t.x, T.get(id).x); assert.equal(t.y, T.get(id).y); }
      for (const node of a.getGraph().nodes) { node.x = T.get(node.id).x; node.y = T.get(node.id).y; }
      for (const flipped of [false, true]) {
        a._flipped = flipped;
        const bs = a.getGraph().nodes.map(q => a._boxOf(q));
        for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
          const u = bs[i], v = bs[j];
          assert.ok(!(u.x < v.x + v.w && v.x < u.x + u.w && u.y < v.y + v.h && v.y < u.y + u.h), `nodes ${i} and ${j} overlap (${flipped ? 'flipped' : 'unflipped'})`);
        }
      }
      // Laying out a laid-out graph again may still find a better arrangement (it prefers fewer edges cutting
      // through nodes and fewer crossings, even at some cost in height), but it must settle at a fixed point quickly.
      const layOut = () => { const t = a._computeLayoutTargets(); for (const q of a.getGraph().nodes) { q.x = t.get(q.id).x; q.y = t.get(q.id).y; } return a.exportJSON(); };
      let prev = a.exportJSON(), settledAfter = 0;
      for (let i = 1; i <= 4; i++) {
        const next = layOut();
        if (next === prev) { settledAfter = i; break; }
        prev = next;
      }
      assert.ok(settledAfter > 0, 'laying out again reaches a fixed point within four more layouts');
    });
  }
});
