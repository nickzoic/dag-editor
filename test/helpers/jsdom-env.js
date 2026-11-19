'use strict';
/*
 * Test environment for the unit tests: dag-editor.js running inside jsdom.
 *
 * jsdom does no layout, so element sizes are stubbed (see `size`), and the clock and
 * requestAnimationFrame are replaced by a manual clock so animations run instantly and
 * deterministically.
 *
 * The source is compiled once with its real file name, which lets V8 attribute coverage to
 * dag-editor.js (so c8 can report on it).
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC = path.resolve(__dirname, '..', '..', 'dag-editor.js');
const SCRIPT = new vm.Script(
  fs.readFileSync(SRC, 'utf8') + '\n;window.DAGEditor = DAGEditor; window.DAGNode = DAGNode; window.DAGEdge = DAGEdge;',
  { filename: SRC });

const TOOLBAR_AND_HINT = 66;   // px of the container taken by the toolbar (42) and hint bar (24)

/** A manual clock: requestAnimationFrame callbacks only run when the test advances time. */
function makeClock(win) {
  const clock = { now: 0, queue: [], nextId: 1 };
  Object.defineProperty(win.performance, 'now', { value: () => clock.now, configurable: true });
  win.requestAnimationFrame = cb => { const id = clock.nextId++; clock.queue.push({ id, cb }); return id; };
  win.cancelAnimationFrame = id => { clock.queue = clock.queue.filter(q => q.id !== id); };
  /** Advance time by `ms`, running animation frames at 60 Hz. */
  clock.advance = (ms) => {
    const end = clock.now + ms;
    while (clock.now < end) {
      clock.now = Math.min(end, clock.now + 1000 / 60);
      const due = clock.queue; clock.queue = [];
      for (const q of due) q.cb(clock.now);
    }
  };
  return clock;
}

/**
 * Create an editor in a fresh jsdom window.
 * @param {object}  [o]
 * @param {number}  [o.width=800]   container width (jsdom has no layout, so this is stubbed)
 * @param {number}  [o.height=500]  container height
 * @param {boolean} [o.resizeObserver=true]  provide a (fake) ResizeObserver; false tests the window-resize fallback
 * @param {boolean} [o.segmenter=true]       false removes Intl.Segmenter before the editor loads
 * @param {string}  [o.html]        page markup; must contain <div id="c"></div> unless `create` is false
 * @param {boolean} [o.create=true] construct the editor
 */
function createEnv({ width = 800, height = 500, resizeObserver = true, segmenter = true,
                     html = '<!doctype html><div id="c"></div>', create = true } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const size = { w: width, h: height };
  const rect = (w, h) => ({ left: 0, top: 0, x: 0, y: 0, width: w, height: h, right: w, bottom: h });
  win.HTMLElement.prototype.getBoundingClientRect = () => rect(size.w, size.h);
  win.SVGElement.prototype.getBoundingClientRect = () => rect(size.w, Math.max(0, size.h - TOOLBAR_AND_HINT));
  const clock = makeClock(win);
  const timeouts = [];                                         // setTimeout callbacks, run on demand
  win.setTimeout = (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; };

  let observer = null;
  if (resizeObserver) {
    win.ResizeObserver = class {
      constructor(cb) { this.cb = cb; this.disconnected = false; observer = this; }
      observe(el) { this.el = el; }
      disconnect() { this.disconnected = true; }
    };
  }
  if (!segmenter) delete win.Intl.Segmenter;

  SCRIPT.runInContext(dom.getInternalVMContext());

  const env = {
    dom, win, document: win.document, clock, size, events: [], timeouts, moves: [], notices: [], layouts: [], pins: [],
    get observer() { return observer; },
    container: win.document.getElementById('c'),
    editor: null,
    /** Resize the (stubbed) container and notify the editor the way a browser would. */
    resize(w, h) {
      size.w = w; size.h = h;
      if (observer) observer.cb([]); else win.dispatchEvent(new win.Event('resize'));
    },
    /** Run the animation to the end (or `limit` ms). Returns the elapsed ms. */
    settle(limit = 3000) {
      const start = clock.now;
      while (env.editor._layoutActive && clock.now - start < limit) clock.advance(1000 / 60);
      return clock.now - start;
    },
    /** Run (and clear) the callbacks that were passed to setTimeout. */
    runTimeouts() { const due = timeouts.splice(0); for (const t of due) t.fn(); },
    /** Where a point of the graph (display coordinates) is on screen, given the current view. */
    client(gx, gy) { const e = env.editor; return { x: e._viewX + gx * e._scale, y: e._viewY + gy * e._scale }; },
    /** The SVG element of a node (by id), and one of its port dots. */
    nodeEl(id) { return env.document.querySelector(`[data-id="${id}"]`); },
    portEl(id, portId, dir) { return env.nodeEl(id).querySelector(`circle[data-port-uid="${portId}:${dir}"]`); },
    /** Dispatch a mouse event at client coordinates. */
    mouse(target, type, x = 0, y = 0, init = {}) {
      const ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    /** Dispatch a key event on the container (where the editor listens). */
    key(key, init = {}) {
      const ev = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      (init.target || env.container).dispatchEvent(ev);
      return ev;
    },
  };
  if (create) {
    // A subclass that records the hooks as events: the node / edge events in env.events (with the names the
    // tests use), and the rest in their own lists.
    const events = env.events;
    class Recorder extends win.DAGEditor {
      onAddNode(node)      { events.push({ type: 'created', node }); }
      onDeleteNode(node)   { events.push({ type: 'deleted', node }); }
      onSelectNode(node)   { events.push({ type: 'selected', node }); }
      onSelectEdge(edge)   { events.push({ type: 'selected', edge }); }
      onDeselectNode(node) { events.push({ type: 'deselected', node }); }
      onDeselectEdge(edge) { events.push({ type: 'deselected', edge }); }
      onUpdateNode(node)   { events.push({ type: 'updated', node }); }
      onAddEdge(edge)      { events.push({ type: 'edge-created', edge }); }
      onDeleteEdge(edge)   { events.push({ type: 'edge-deleted', edge }); }
      onMoveNode(node)     { env.moves.push(node); }
      onNotice(message)    { env.notices.push(message); }
      onLayoutChange(active) { env.layouts.push(active); }
      onPinChange(pinned)  { env.pins.push(pinned); }
    }
    env.editor = new Recorder(env.container);
  }
  return env;
}

/** Shorthand for a port definition. */
const port = (id, label = '') => ({ id, label });

/** Load a graph given as { nodes: [[id, label, x, y, inputs, outputs]], edges: [[id, from, fromPort, to, toPort]] } */
function graph(nodes, edges = []) {
  return {
    version: 2,
    nodes: nodes.map(([id, label, x, y, inputs = [port('in')], outputs = [port('out')]]) => ({ id, label, x, y, inputs, outputs })),
    edges: edges.map(([id, fromNodeId, fromPortId, toNodeId, toPortId]) => ({ id, fromNodeId, fromPortId, toNodeId, toPortId })),
  };
}

/**
 * Deep-equality that works on data from the jsdom window. Objects made inside jsdom live in another
 * JavaScript realm (different Object / Array prototypes), which assert.deepStrictEqual rejects even
 * when the contents match; comparing their JSON forms avoids that.
 */
const assert = require('node:assert/strict');
const plain = v => JSON.parse(JSON.stringify(v));
const same = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);

module.exports = { createEnv, makeClock, port, graph, same, plain, SRC };
