/**
 * DAGEditor — Standalone directed-acyclic-graph editor
 *
 * Requires dag-editor.css to be loaded in the page:
 *   <link rel="stylesheet" href="dag-editor.css">
 *
 * Usage:
 *   const editor = new DAGEditor(containerDiv, (event) => {
 *     // event.type: 'created'|'selected'|'deselected'|'updated'|'deleted'
 *     //             |'edge-created'|'edge-deleted'
 *     // event.node  → DAGNode instance  (node events)
 *     // event.edge  → DAGEdge instance  (edge events)
 *   });
 *
 * Node labels and ports are edited through the API (the host page supplies the
 * UI): setNodeLabel(), addPort(), removePort(), setPortLabel().
 *
 * Orientation: if the container is taller than it is wide, the graph is shown FLIPPED —
 * the axes are swapped, so inputs are on the top edge of each node, outputs on the bottom
 * edge, and strata run top to bottom. Flipping is display only: node.x / node.y (and so
 * toJSON / getGraph) are always in the unflipped, left-to-right orientation. Whenever the
 * container is resized the graph is re-fitted, and flipped or unflipped as appropriate.
 *
 * Mouse interactions:
 *   - Click empty canvas      → create node
 *   - Click node              → select node
 *   - Drag node body          → move node
 *   - Drag output port (●)    → start edge; drop on input port or node to connect,
 *                               drop on canvas to create + connect a new node
 *   - Drag input port (●)     → same, in reverse direction
 *   - Click edge              → select edge
 *   - Double-click edge       → insert a new node on the edge
 *
 * Keyboard shortcuts:
 *   Delete / Backspace  → delete selected
 *   Escape              → deselect
 *   N                   → new node at centre
 *   Tab / Shift+Tab     → cycle node selection
 *   L                   → toggle auto-layout
 *   Ctrl+Z / Cmd+Z      → undo
 *   Ctrl+Shift+Z        → redo
 */

/* ─────────────────────────── DAGNode class ─────────────────────────── */
class DAGNode {
  /**
   * @param {object} opts
   * @param {string}   opts.id
   * @param {string}   [opts.label]
   * @param {number}   [opts.x]
   * @param {number}   [opts.y]
   * @param {Array<{id:string, label?:string}>} [opts.inputs]
   * @param {Array<{id:string, label?:string}>} [opts.outputs]
   */
  constructor({ id, label = '', x = 0, y = 0, inputs = [], outputs = [] }) {
    this.id      = id;
    this.label   = label;
    this.x       = x;
    this.y       = y;
    this.inputs  = inputs.map(p => ({ id: p.id, label: p.label ?? '' }));
    this.outputs = outputs.map(p => ({ id: p.id, label: p.label ?? '' }));
  }

  /** JSON-serialisable plain object */
  toJSON() {
    return {
      id: this.id, label: this.label, x: this.x, y: this.y,
      inputs:  this.inputs.map(p => ({ id: p.id, label: p.label })),
      outputs: this.outputs.map(p => ({ id: p.id, label: p.label })),
    };
  }

  static fromJSON(data) { return new DAGNode(data); }
}

/* ─────────────────────────── DAGEdge class ─────────────────────────── */
class DAGEdge {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.fromNodeId
   * @param {string} opts.fromPortId
   * @param {string} opts.toNodeId
   * @param {string} opts.toPortId
   */
  constructor({ id, fromNodeId, fromPortId, toNodeId, toPortId }) {
    this.id         = id;
    this.fromNodeId = fromNodeId;
    this.fromPortId = fromPortId;
    this.toNodeId   = toNodeId;
    this.toPortId   = toPortId;
  }

  toJSON() {
    return { id: this.id, fromNodeId: this.fromNodeId, fromPortId: this.fromPortId,
             toNodeId: this.toNodeId, toPortId: this.toPortId };
  }

  static fromJSON(data) { return new DAGEdge(data); }
}

/* ─────────────────────────── DAGEditor class ───────────────────────── */
class DAGEditor {
  constructor(container, onChange) {
    if (!(container instanceof HTMLElement)) throw new Error('DAGEditor: first argument must be an HTMLElement');
    this._container = container;
    this._onChange  = typeof onChange === 'function' ? onChange : () => {};

    this._nodes   = new Map();  // id → DAGNode
    this._edges   = new Map();  // id → DAGEdge
    this._nodeSeq = 0;
    this._edgeSeq = 0;

    this._selected  = null;   // { kind:'node'|'edge', id }
    this._dragging  = null;
    this._edgeDraft = null;   // { fromNodeId, fromPortId } | { toNodeId, toPortId }  + x1,y1,x2,y2
    this._panning   = null;
    this._viewX = 0; this._viewY = 0; this._scale = 1;

    this._undoStack = [];        // snapshots; index 0 is the baseline (initial state)
    this._redoStack = [];
    this._lastSnapKey = null;    // lets repeated edits of one field share an undo step
    this._lineCache   = new Map();   // "id|U" / "id|F" → { id, label, maxW, lines }  (wrapped label text)
    this._flipCache   = new Map();   // node id → { sig, g }  (geometry of the node when flipped)
    this._routes      = null;        // { sig, paths }: edge routes from the last layout (see _routesValid)
    this._flipped     = false;       // shown with the axes swapped (container taller than wide)?
    this._resizeObserver = null;

    this._layoutActive    = false;
    this._layoutPinned    = false;   // double-click mode: re-layout on every graph change
    this._layoutRaf       = null;
    this._layoutTargets   = new Map();   // node id → { x, y }: where the running layout is heading
    this._layoutStartTime = 0;
    this._layoutLastTime  = 0;

    this._buildDOM();
    this._attachEvents();
    this._flipped = this._isPortrait();
    this._svg.classList.toggle('dag-svg--flipped', this._flipped);
    this._watchSize();
    this._render();
    this._undoStack.push(this._serialise());
  }

  /* ───────────────── layout constants ─────────────── */
  static _NODE_W        = 140;
  static _NODE_MIN_H    = 46;
  static _PORT_PITCH    = 22;   // px between port centres
  static _PORT_TOP      = 32;   // y of first port (below label)
  static _PORT_R        = 6;    // port circle radius
  static _PORT_HIT_R    = 12;   // hit-test radius
  static _NODE_RX       = 8;
  static _LINE_H        = 16;   // line height of the node label
  static _FLIP_W        = 120;  // least width of a node when flipped (it grows to fit its ports)
  static _FLIP_LABEL_W  = 100;  // label wrap width when flipped
  static _LAYOUT_DEADLINE = 1500;   // ms: an auto-layout run always ends by now
  static _LAYOUT_TAU      = 90;     // ms: time constant of the glide to the target (settles in <0.8 s)
  static _LAYOUT_COL_GAP  = 70;     // px between columns (strata)
  static _LAYOUT_NODE_GAP = 40;     // px, minimum gap between nodes in a column
  static _LABEL_W_COMPACT  = 98;    // label wrap width, compact nodes (leaves room for 1-char port labels)
  static _LABEL_W_EXPANDED = 120;   // label wrap width, expanded nodes (label sits in its own header)

  /* Splits text into user-perceived characters (grapheme clusters), so that e.g.
   * 'x̅' (x + combining overline), 'é' written as e + accent, flags and ZWJ emoji
   * sequences each count as ONE character. Null where Intl.Segmenter is unavailable. */
  static _segmenter = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
  static _shortLabelCache = new Map();

  /* Approximation used only when Intl.Segmenter is missing: counts code points, but
   * folds combining marks, variation selectors, skin tones, ZWJ sequences and flag pairs
   * into the character they belong to. */
  static _hasAtMostOneCharFallback(s) {
    let n = 0, glued = false, flag = false;
    for (const ch of s) {
      if (glued) { glued = false; continue; }                                  // joined on by a ZWJ
      if (ch === '\u200d') { glued = true; continue; }
      if (/[\p{M}\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}]/u.test(ch)) continue;      // marks, selectors, skin tones
      if (/[\u{1F1E6}-\u{1F1FF}]/u.test(ch)) {                                 // regional indicators pair into a flag
        if (flag) { flag = false; continue; }
        flag = true;
      } else flag = false;
      if (++n > 1) return false;
    }
    return true;
  }

  /* A label is "short" if it is empty or a single user-perceived character. */
  static _isShortLabel(label) {
    const s = String(label ?? '');
    if (s.length <= 1) return true;                  // one UTF-16 unit is always one character
    const cache = DAGEditor._shortLabelCache;
    let short = cache.get(s);
    if (short === undefined) {
      if (DAGEditor._segmenter) {
        let n = 0;                                   // stop at the second character
        for (const _ of DAGEditor._segmenter.segment(s)) { if (++n > 1) break; }
        short = n <= 1;
      } else {
        short = DAGEditor._hasAtMostOneCharFallback(s);
      }
      if (cache.size >= 1000) cache.clear();
      cache.set(s, short);
    }
    return short;
  }

  /* Compact layout: no header/divider; label centred, ports stacked at mid-height.
   * A node is compact unless one of its PORT labels is longer than one user-perceived
   * character — so any number of unlabelled or single-character-labelled ports stays
   * compact, while a longer port label needs the expanded layout. (The node's own
   * label is not considered: it wraps instead.) */
  _isCompact(node) {
    return node.inputs.every(p => DAGEditor._isShortLabel(p.label)) &&
           node.outputs.every(p => DAGEditor._isShortLabel(p.label));
  }

  /* ── node label wrapping ── */

  /* Rendered width of a string in the node-label font; estimated when it cannot be measured. */
  _textWidth(str, el = this._measureEl, charW = 7.2) {
    if (el && typeof el.getComputedTextLength === 'function') {
      el.textContent = str;
      const w = el.getComputedTextLength();
      if (w > 0) return w;
    }
    return str.length * charW;
  }

  /* Same for a port label, which is set in a smaller font. */
  _portTextWidth(str) { return this._textWidth(str, this._measurePortEl, 5.8); }

  /* Greedy word wrap to maxW. A word wider than a whole line is split into line-sized pieces. */
  _wrapLabel(text, maxW) {
    const words = String(text).split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lines = [];
    let line = '';
    for (let word of words) {
      while (word.length > 1 && this._textWidth(word) > maxW) {
        let n = word.length - 1;
        while (n > 1 && this._textWidth(word.slice(0, n)) > maxW) n--;
        if (line) { lines.push(line); line = ''; }
        lines.push(word.slice(0, n));
        word = word.slice(n);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (!line || this._textWidth(candidate) <= maxW) line = candidate;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines;
  }

  /* Wrapped lines of a node's label, for the current orientation unless told otherwise
   * (cached until the label or layout class changes). */
  _labelLines(node, flipped = this._flipped) {
    const maxW = flipped ? DAGEditor._FLIP_LABEL_W
               : this._isCompact(node) ? DAGEditor._LABEL_W_COMPACT : DAGEditor._LABEL_W_EXPANDED;
    const key = node.id + (flipped ? '|F' : '|U');
    let c = this._lineCache.get(key);
    if (!c || c.label !== node.label || c.maxW !== maxW) {
      c = { id: node.id, label: node.label, maxW, lines: this._wrapLabel(node.label, maxW) };
      this._lineCache.set(key, c);
    }
    return c.lines;
  }

  /* ── Unflipped (model-space) geometry ──────────────────────────────────────
   * _headerHeight / _nodeHeight / _portLocalY describe a node in the unflipped,
   * left-to-right orientation, whatever orientation is being shown. The layout and
   * the exported positions are in these terms; _boxOf / _flipGeom turn them into
   * what is actually drawn. */

  /* Expanded nodes: height of the header (label block) above the ports. */
  _headerHeight(node) {
    return DAGEditor._PORT_TOP + (this._labelLines(node, false).length - 1) * DAGEditor._LINE_H;
  }

  /* Dynamic node height: grows to fit the wrapped label and the ports. */
  _nodeHeight(node) {
    const PP    = DAGEditor._PORT_PITCH;
    const ports = Math.max(node.inputs.length, node.outputs.length);
    if (this._isCompact(node)) {
      const labelH = this._labelLines(node, false).length * DAGEditor._LINE_H + 30;
      return Math.max(DAGEditor._NODE_MIN_H, labelH, ports * PP + 16);
    }
    return this._headerHeight(node) + ports * PP + 8;
  }

  /* y of port number idx, relative to the node's top. Compact: a stack centred on the node. */
  _portLocalY(node, direction, idx) {
    const PP = DAGEditor._PORT_PITCH;
    if (this._isCompact(node)) {
      const n = direction === 'input' ? node.inputs.length : node.outputs.length;
      return this._nodeHeight(node) / 2 + (idx - (n - 1) / 2) * PP;
    }
    return this._headerHeight(node) + idx * PP + PP / 2;
  }

  /* ── Flipped geometry ──────────────────────────────────────────────────────
   * Flipped, a node has its inputs along the top edge and its outputs along the bottom edge. The n
   * ports on a side are evenly spread across the node's width, at 1/(n+1), 2/(n+1) … n/(n+1) of it
   * (one port in the middle, two at thirds, three at quarters), whatever their labels. Each label
   * sits upright just inside the edge, under (or over) its port, so the node is made wide enough
   * that the widest label on a side fits in that side's spacing (labels are short and nodes rarely
   * have more than a few ports, so the usual minimum width is normally enough). */
  _flipGeom(node) {
    const sig = JSON.stringify([node.label, node.inputs.map(p => p.label), node.outputs.map(p => p.label)]);
    const hit = this._flipCache.get(node.id);
    if (hit && hit.sig === sig) return hit.g;

    const PP = DAGEditor._PORT_PITCH, LH = DAGEditor._LINE_H;
    const compact = this._isCompact(node);
    const lines   = this._labelLines(node, true);

    // Least width this side needs: n+1 gaps, each at least 22 px and wide enough for the widest label.
    const need = ports => {
      const widest = Math.max(0, ...ports.map(p => p.label ? this._portTextWidth(p.label) : 0));
      return { widest, width: (ports.length + 1) * Math.max(PP, widest + 10) };
    };
    const top = need(node.inputs), bottom = need(node.outputs);
    const w = Math.max(DAGEditor._FLIP_W, top.width, bottom.width);
    const zone = n => n.widest ? 22 : 8;                    // label row + the dot's overhang, or just the overhang
    const h = Math.max(DAGEditor._NODE_MIN_H, zone(top) + lines.length * LH + 12 + zone(bottom));

    const spread = ports => ports.map((_, i) => w * (i + 1) / (ports.length + 1));
    const g = { w, h, top: zone(top), bottom: zone(bottom), compact,
                inX: spread(node.inputs), outX: spread(node.outputs) };
    this._flipCache.set(node.id, { sig, g });
    return g;
  }

  /* The box a node is drawn in, in display space. Flipped, the centre of the node's unflipped box
   * is transposed (x ↔ y), so the nodes keep their positions relative to one another. */
  _boxOf(node, f = null) {
    const W  = DAGEditor._NODE_W, hu = this._nodeHeight(node);
    if (!this._flipped) return { x: node.x, y: node.y, w: W, h: hu };
    f = f || this._flipGeom(node);
    const cx = node.x + W / 2, cy = node.y + hu / 2;
    return { x: cy - f.w / 2, y: cx - f.h / 2, w: f.w, h: f.h };
  }

  /* Display position of port number idx. direction: 'input' | 'output' */
  _portPos(node, direction, idx) {
    if (!this._flipped) {
      return { x: node.x + (direction === 'output' ? DAGEditor._NODE_W : 0),
               y: node.y + this._portLocalY(node, direction, idx) };
    }
    const f = this._flipGeom(node), b = this._boxOf(node, f);
    return direction === 'output' ? { x: b.x + f.outX[idx], y: b.y + b.h }
                                  : { x: b.x + f.inX[idx],  y: b.y };
  }

  /* Position of a specific output port in graph (display) coords */
  _outputPortPos(node, portId) {
    const idx = node.outputs.findIndex(p => p.id === portId);
    return idx < 0 ? null : this._portPos(node, 'output', idx);
  }

  /* Position of a specific input port in graph (display) coords */
  _inputPortPos(node, portId) {
    const idx = node.inputs.findIndex(p => p.id === portId);
    return idx < 0 ? null : this._portPos(node, 'input', idx);
  }

  /* First output / input port positions (or where they would be, for a node without ports) */
  _firstOutputPos(node) {
    if (node.outputs.length) return this._portPos(node, 'output', 0);
    const b = this._boxOf(node);
    return this._flipped ? { x: b.x + b.w / 2, y: b.y + b.h } : { x: b.x + b.w, y: b.y + b.h / 2 };
  }

  _firstInputPos(node) {
    if (node.inputs.length) return this._portPos(node, 'input', 0);
    const b = this._boxOf(node);
    return this._flipped ? { x: b.x + b.w / 2, y: b.y } : { x: b.x, y: b.y + b.h / 2 };
  }

  /* Where an edge starts / ends on a port: its outer surface, along the direction of flow. */
  _portSurface(pos, direction) {
    const d = direction === 'output' ? DAGEditor._PORT_R : -DAGEditor._PORT_R;
    return this._flipped ? { x: pos.x, y: pos.y + d } : { x: pos.x + d, y: pos.y };
  }

  _nodeHitTest(node, gx, gy) {
    const b = this._boxOf(node);
    return gx >= b.x && gx <= b.x + b.w && gy >= b.y && gy <= b.y + b.h;
  }

  _portHitTest(pos, gx, gy) {
    return pos && Math.hypot(gx - pos.x, gy - pos.y) <= DAGEditor._PORT_HIT_R;
  }

  /* ─────────────────── DOM setup ─────────────────── */
  _buildDOM() {
    const c = this._container;
    c.style.position   = 'relative';
    c.style.overflow   = 'hidden';
    c.style.userSelect = 'none';
    c.style.outline    = 'none';
    if (!c.style.width)  c.style.width  = '100%';
    // Fall back to a default height only if the page's CSS gave the container none
    // (otherwise honour the layout, e.g. a flex/grid cell that fills the page).
    if (!c.style.height && c.getBoundingClientRect().height < 1) c.style.height = '480px';
    c.setAttribute('tabindex', '0');

    this._toolbar = document.createElement('div');
    this._toolbar.className = 'dag-toolbar';
    this._toolbar.innerHTML = `
      <span class="dag-brand">DAG Editor</span>
      <div class="dag-toolbar-actions">
        <button data-action="add-node"    title="New node (N)">+ Node</button>
        <button data-action="del-selected" title="Delete selected (Del)">Delete</button>
        <button data-action="undo"        title="Undo (Ctrl+Z)">↩ Undo</button>
        <button data-action="redo"        title="Redo (Ctrl+Shift+Z)">↪ Redo</button>
        <button data-action="fit"         title="Fit graph to view">Fit</button>
        <button data-action="layout"      title="Toggle auto-layout (L)" class="dag-btn-layout">⟳ Layout</button>
      </div>`;
    c.appendChild(this._toolbar);

    this._svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this._svg.setAttribute('class', 'dag-svg');
    this._svg.setAttribute('tabindex', '-1');
    this._svg.innerHTML = `<defs>
      <marker id="dag-arrow"       markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse">
        <polygon points="0 0, 8 3, 0 6" fill="var(--dag-edge)"/>
      </marker>
      <marker id="dag-arrow-sel"   markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse">
        <polygon points="0 0, 8 3, 0 6" fill="#2ee8c0"/>
      </marker>
      <marker id="dag-arrow-draft" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse">
        <polygon points="0 0, 8 3, 0 6" fill="var(--dag-draft)"/>
      </marker>
    </defs>`;

    // Hidden text used to measure label widths for wrapping (same class => same font)
    this._measureEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    this._measureEl.setAttribute('class', 'dag-node-label');
    this._measureEl.setAttribute('visibility', 'hidden');
    this._measureEl.setAttribute('x', 0);
    this._measureEl.setAttribute('y', 0);
    this._svg.appendChild(this._measureEl);
    this._measurePortEl = this._measureEl.cloneNode(false);        // the same, in the port-label font
    this._measurePortEl.setAttribute('class', 'dag-port-label');
    this._svg.appendChild(this._measurePortEl);

    this._gEdges   = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this._gNodes   = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this._draftLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    this._draftLine.setAttribute('class', 'dag-edge-draft');
    this._draftLine.style.display = 'none';
    this._gEdges.appendChild(this._draftLine);

    // Nodes first, edges on top — so edges are always visible over nodes
    this._svg.appendChild(this._gNodes);
    this._svg.appendChild(this._gEdges);
    c.appendChild(this._svg);

    this._hint = document.createElement('div');
    this._hint.className = 'dag-hint';
    this._hint.textContent = 'Click canvas to add a node · Drag a port to draw an edge · Drop on canvas to auto-create a node · Del to delete';
    c.appendChild(this._hint);
  }

  _attachEvents() {
    this._svg.addEventListener('mousedown',  e => this._onMouseDown(e));
    this._svg.addEventListener('mousemove',  e => this._onMouseMove(e));
    this._svg.addEventListener('mouseup',    e => this._onMouseUp(e));
    this._svg.addEventListener('mouseleave', e => this._onMouseLeave(e));
    this._svg.addEventListener('wheel',      e => this._onWheel(e), { passive: false });
    this._svg.addEventListener('dblclick',   e => this._onDblClick(e));
    this._container.addEventListener('keydown', e => this._onKeyDown(e));

    this._toolbar.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const a = btn.dataset.action;
      if (a === 'add-node')     this._createNodeAtCenter();
      if (a === 'del-selected') this._deleteSelected();
      if (a === 'undo')         this.undo();
      if (a === 'redo')         this.redo();
      if (a === 'fit')          this._fitView();
      if (a === 'layout')       this.autoLayout(!this._layoutActive);
      this._container.focus();
    });

    this._toolbar.addEventListener('dblclick', e => {
      const btn = e.target.closest('[data-action="layout"]');
      if (!btn) return;
      e.preventDefault();
      // Double-click toggles pinned mode (auto-layout on every graph change)
      this._layoutPinned = !this._layoutPinned;
      this._updateLayoutBtn();
      if (this._layoutPinned) {
        // Start an immediate layout run if not already running
        if (!this._layoutActive) this.autoLayout(true);
      } else {
        // Unpinning: also stop any active run
        if (this._layoutActive) this.autoLayout(false);
      }
      this._container.focus();
    });
  }

  /* ─────────────────── orientation and resizing ─────────────────── */

  /* Flipped (portrait) when the container is taller than it is wide. */
  _isPortrait() {
    const r = this._container.getBoundingClientRect();
    return r.height > r.width;
  }

  _watchSize() {
    const onResize = () => this._onResize();
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(onResize);
      this._resizeObserver.observe(this._container);
    } else {                                           // very old browsers: window resizes only
      this._windowResize = onResize;
      window.addEventListener('resize', onResize);
    }
  }

  /* The container changed size: pick the orientation again and re-fit the graph to the new
   * size. (The model is untouched; only how it is drawn changes.) */
  _onResize() {
    const flipped = this._isPortrait();
    if (flipped !== this._flipped) {
      this._flipped = flipped;
      this._svg.classList.toggle('dag-svg--flipped', flipped);
    }
    this._fitView();
  }

  /* Whether the graph is currently shown flipped (axes swapped). */
  get flipped() { return this._flipped; }

  /* ─────────────────── coordinate helpers ─────────────────── */
  _svgRect() { return this._svg.getBoundingClientRect(); }

  _clientToGraph(cx, cy) {
    const r = this._svgRect();
    return { x: (cx - r.left - this._viewX) / this._scale,
             y: (cy - r.top  - this._viewY) / this._scale };
  }

  _applyTransform() {
    const t = `translate(${this._viewX},${this._viewY}) scale(${this._scale})`;
    this._gEdges.setAttribute('transform', t);
    this._gNodes.setAttribute('transform', t);
  }

  /* ─────────────────── mouse handlers ─────────────────── */
  _onMouseDown(e) {
    if (e.button !== 0) return;
    this._container.focus();
    const gp = this._clientToGraph(e.clientX, e.clientY);

    // --- port drag
    for (const node of this._nodes.values()) {
      // Output ports
      for (const port of node.outputs) {
        const pos = this._outputPortPos(node, port.id);
        if (this._portHitTest(pos, gp.x, gp.y)) {
          const { x: sx, y: sy } = this._portSurface(pos, 'output');   // start at the port surface
          this._edgeDraft = { fromNodeId: node.id, fromPortId: port.id,
                              x1: sx, y1: sy, x2: gp.x, y2: gp.y };
          this._draftLine.setAttribute('x1', sx);   this._draftLine.setAttribute('y1', sy);
          this._draftLine.setAttribute('x2', gp.x); this._draftLine.setAttribute('y2', gp.y);
          this._draftLine.style.display = '';
          e.stopPropagation(); return;
        }
      }
      // Input ports
      for (const port of node.inputs) {
        const pos = this._inputPortPos(node, port.id);
        if (this._portHitTest(pos, gp.x, gp.y)) {
          const { x: ex, y: ey } = this._portSurface(pos, 'input');    // end at the port surface
          this._edgeDraft = { toNodeId: node.id, toPortId: port.id,
                              x1: gp.x, y1: gp.y, x2: ex, y2: ey };
          this._draftLine.setAttribute('x1', gp.x); this._draftLine.setAttribute('y1', gp.y);
          this._draftLine.setAttribute('x2', ex);   this._draftLine.setAttribute('y2', ey);
          this._draftLine.style.display = '';
          e.stopPropagation(); return;
        }
      }
    }

    // --- node drag
    for (const node of this._nodes.values()) {
      if (this._nodeHitTest(node, gp.x, gp.y)) {
        this._setSelected('node', node.id);
        this._dragging = { nodeId: node.id,
                           startX: e.clientX, startY: e.clientY,
                           origX: node.x, origY: node.y };
        e.stopPropagation(); return;
      }
    }

    // --- edge click
    const valid = this._routesValid();
    for (const edge of this._edges.values()) {
      if (this._edgeHitTest(edge, gp.x, gp.y, 7, valid)) {
        this._setSelected('edge', edge.id);
        e.stopPropagation(); return;
      }
    }

    // --- pan
    if (e.altKey) {
      this._panning = { startX: e.clientX, startY: e.clientY, origVX: this._viewX, origVY: this._viewY };
      return;
    }

    // --- empty canvas → new node
    this._setSelected(null, null);
    this._createNodeAtDisplay(gp.x, gp.y);
  }

  _onMouseMove(e) {
    const gp = this._clientToGraph(e.clientX, e.clientY);

    if (this._edgeDraft) {
      if (this._edgeDraft.fromNodeId) {
        this._edgeDraft.x2 = gp.x; this._edgeDraft.y2 = gp.y;
        this._draftLine.setAttribute('x2', gp.x); this._draftLine.setAttribute('y2', gp.y);
      } else {
        this._edgeDraft.x1 = gp.x; this._edgeDraft.y1 = gp.y;
        this._draftLine.setAttribute('x1', gp.x); this._draftLine.setAttribute('y1', gp.y);
      }
      this._updatePortTargets(gp.x, gp.y);
      this._render();
      return;
    }

    if (this._dragging) {
      const dx = (e.clientX - this._dragging.startX) / this._scale;
      const dy = (e.clientY - this._dragging.startY) / this._scale;
      const node = this._nodes.get(this._dragging.nodeId);
      // flipped, the screen's x axis is the model's y axis and vice versa
      node.x = this._dragging.origX + (this._flipped ? dy : dx);
      node.y = this._dragging.origY + (this._flipped ? dx : dy);
      this._render(); return;
    }

    if (this._panning) {
      this._viewX = this._panning.origVX + (e.clientX - this._panning.startX);
      this._viewY = this._panning.origVY + (e.clientY - this._panning.startY);
      this._applyTransform(); return;
    }

    // Cursor feedback
    let overPort = false;
    for (const node of this._nodes.values()) {
      for (const p of node.outputs) {
        if (this._portHitTest(this._outputPortPos(node, p.id), gp.x, gp.y)) { overPort = true; break; }
      }
      if (overPort) break;
      for (const p of node.inputs) {
        if (this._portHitTest(this._inputPortPos(node, p.id), gp.x, gp.y)) { overPort = true; break; }
      }
      if (overPort) break;
    }
    this._svg.style.cursor = overPort ? 'crosshair' : '';
  }

  _onMouseUp(e) {
    if (this._edgeDraft) {
      const gp    = this._clientToGraph(e.clientX, e.clientY);
      const draft = this._edgeDraft;
      this._edgeDraft = null;
      this._draftLine.style.display = 'none';
      this._clearPortTargets();

      if (draft.fromNodeId) {
        // Output drag → find a compatible input port
        let landed = false;
        for (const node of this._nodes.values()) {
          if (node.id === draft.fromNodeId) continue;
          // Check specific input ports first
          for (const port of node.inputs) {
            if (this._portHitTest(this._inputPortPos(node, port.id), gp.x, gp.y)) {
              this._tryAddEdge(draft.fromNodeId, draft.fromPortId, node.id, port.id);
              landed = true; break;
            }
          }
          if (landed) break;
          // Fall back to node body → first input port
          if (this._nodeHitTest(node, gp.x, gp.y) && node.inputs.length) {
            this._tryAddEdge(draft.fromNodeId, draft.fromPortId, node.id, node.inputs[0].id);
            landed = true; break;
          }
        }
        if (!landed) {
          const nn = this._createNodeAtDisplay(gp.x, gp.y);
          if (nn.inputs.length) this._tryAddEdge(draft.fromNodeId, draft.fromPortId, nn.id, nn.inputs[0].id);
        }
      } else {
        // Input drag → find a compatible output port
        let landed = false;
        for (const node of this._nodes.values()) {
          if (node.id === draft.toNodeId) continue;
          for (const port of node.outputs) {
            if (this._portHitTest(this._outputPortPos(node, port.id), gp.x, gp.y)) {
              this._tryAddEdge(node.id, port.id, draft.toNodeId, draft.toPortId);
              landed = true; break;
            }
          }
          if (landed) break;
          if (this._nodeHitTest(node, gp.x, gp.y) && node.outputs.length) {
            this._tryAddEdge(node.id, node.outputs[0].id, draft.toNodeId, draft.toPortId);
            landed = true; break;
          }
        }
        if (!landed) {
          const nn = this._createNodeAtDisplay(gp.x, gp.y);
          if (nn.outputs.length) this._tryAddEdge(nn.id, nn.outputs[0].id, draft.toNodeId, draft.toPortId);
        }
      }
      this._render(); return;
    }

    if (this._dragging) { this._snapshot(); this._dragging = null; }
    this._panning = null;
  }

  /* Port target highlighting during edge draft */
  _updatePortTargets(gx, gy) {
    const draft = this._edgeDraft;
    for (const node of this._nodes.values()) {
      const g = this._gNodes.querySelector(`[data-id="${node.id}"]`);
      if (!g) continue;
      if (draft.fromNodeId && node.id !== draft.fromNodeId) {
        // Highlight input ports
        for (const port of node.inputs) {
          const el  = g.querySelector(`[data-port-id="${port.id}"][data-port-dir="in"]`);
          const hit = this._portHitTest(this._inputPortPos(node, port.id), gx, gy);
          if (el) el.classList.toggle('dag-port--target', hit);
        }
      } else if (draft.toNodeId && node.id !== draft.toNodeId) {
        // Highlight output ports
        for (const port of node.outputs) {
          const el  = g.querySelector(`[data-port-id="${port.id}"][data-port-dir="out"]`);
          const hit = this._portHitTest(this._outputPortPos(node, port.id), gx, gy);
          if (el) el.classList.toggle('dag-port--target', hit);
        }
      }
    }
  }

  _clearPortTargets() {
    for (const el of this._gNodes.querySelectorAll('.dag-port--target')) {
      el.classList.remove('dag-port--target');
    }
  }

  _onMouseLeave() {
    if (this._edgeDraft) {
      this._edgeDraft = null;
      this._draftLine.style.display = 'none';
      this._clearPortTargets();
    }
    this._panning  = null;
    this._dragging = null;
  }

  _onWheel(e) {
    e.preventDefault();
    const r = this._svgRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const ns = Math.min(4, Math.max(0.15, this._scale * delta));
    this._viewX = mx - (mx - this._viewX) * (ns / this._scale);
    this._viewY = my - (my - this._viewY) * (ns / this._scale);
    this._scale = ns;
    this._applyTransform(); this._render();
  }

  _onDblClick(e) {
    const gp = this._clientToGraph(e.clientX, e.clientY);

    // Edge: insert a new node at the click point and splice it in
    const valid = this._routesValid();
    for (const edge of this._edges.values()) {
      if (!this._edgeHitTest(edge, gp.x, gp.y, 7, valid)) continue;

      const fromNode = this._nodes.get(edge.fromNodeId);
      const toNode   = this._nodes.get(edge.toNodeId);
      if (!fromNode || !toNode) continue;

      // Create the new node centred on the click, with matching port types
      const newNode = this._createNodeAtDisplay(gp.x, gp.y, {
        inputs:  [{ id: 'in',  label: '' }],
        outputs: [{ id: 'out', label: '' }],
      });

      // Remove the original edge
      this._edges.delete(edge.id);
      this._onChange({ type: 'edge-deleted', edge });

      // Connect: upstream → new node input, new node output → downstream
      this._tryAddEdge(edge.fromNodeId, edge.fromPortId, newNode.id, 'in');
      this._tryAddEdge(newNode.id, 'out', edge.toNodeId, edge.toPortId);

      this._snapshot();
      this._render();
      this._triggerPinnedLayout();
      return;
    }
  }

  _onKeyDown(e) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); this.redo(); return; }
    if (ctrl && (e.key === 'y' || e.key === 'Y'))               { e.preventDefault(); this.redo(); return; }
    if (ctrl && (e.key === 'z' || e.key === 'Z'))               { e.preventDefault(); this.undo(); return; }
    switch (e.key) {
      case 'Delete': case 'Backspace': e.preventDefault(); this._deleteSelected(); break;
      case 'Escape': this._setSelected(null, null); break;
      case 'n': case 'N': this._createNodeAtCenter(); break;
      case 'l': case 'L':
        if (e.shiftKey) {
          this._layoutPinned = !this._layoutPinned;
          this._updateLayoutBtn();
          if (this._layoutPinned && !this._layoutActive) this.autoLayout(true);
          if (!this._layoutPinned && this._layoutActive) this.autoLayout(false);
        } else {
          this.autoLayout(!this._layoutActive);
        }
        break;
      case 'Tab': e.preventDefault(); this._selectNextNode(e.shiftKey ? -1 : 1); break;
    }
  }

  /* ─────────────────── edge geometry ─────────────────── */

  /* Edge routes ─────────────────────────────────────────────────────────────
   * Auto-layout gives every edge that spans several columns a route: the points where its curve
   * passes through the lane the layout reserved for it in each column it crosses. The points are in
   * model (unflipped) coordinates. A route is used only while the graph is exactly as the layout left
   * it (the signature in _geomSig). Moving, editing or relabelling anything drops every route, and the
   * edges go back to single curves until the next layout. Routes are not exported. */

  /* A signature of everything a route depends on: where every node is, how big it is, and which edges
   * join which ports. `positions` (id → {x, y}) gives the positions to assume; by default, the current ones. */
  _geomSig(positions = null) {
    let s = '';
    for (const n of this._nodes.values()) {
      const p = positions ? positions.get(n.id) : n;
      const f = this._flipGeom(n);
      s += `${n.id},${p.x},${p.y},${this._nodeHeight(n)},${f.w},${f.h};`;
    }
    for (const e of this._edges.values()) s += `${e.id},${e.fromNodeId},${e.fromPortId},${e.toNodeId},${e.toPortId};`;
    return s;
  }

  /* Whether the routes from the last layout still describe the graph as it is now. */
  _routesValid() { return !!this._routes && this._routes.sig === this._geomSig(); }

  /* The points an edge's route passes through, in model coordinates, or null if it has none (or the
   * graph has changed since it was laid out). `valid` lets a loop over many edges check only once. */
  _routeFor(edge, valid = this._routesValid()) {
    return valid ? (this._routes.paths.get(edge.id) || null) : null;
  }

  /* The cubic Bézier segments that draw an edge, in display coordinates: [{ s, c1, c2, e }, …].
   * An unrouted edge is one segment, the single curve from _edgeGeom. A routed edge is one segment
   * between each pair of consecutive points (its ports, then its route, then its other port), each
   * leaving and arriving horizontally in model terms, so the curve runs through each lane's centre
   * smoothly. Flipped, every point is transposed, so the flow runs down the screen. */
  _edgeSegments(edge, valid = this._routesValid()) {
    const p1 = this._edgeP1(edge), p2 = this._edgeP2(edge);
    if (!p1 || !p2) return null;
    const route = this._routeFor(edge, valid);
    const routed = route && this._routedSegments(p1, p2, route);
    if (routed) return routed;
    const g = this._edgeGeom(p1, p2);
    return [{ s: { x: g.sx, y: g.sy }, c1: { x: g.cx1, y: g.cy1 }, c2: { x: g.cx2, y: g.cy2 }, e: { x: g.ex, y: g.ey } }];
  }

  /* Segments through the route `waypoints` (model coordinates), or null if the route cannot be drawn. */
  _routedSegments(p1, p2, waypoints) {
    const PR = DAGEditor._PORT_R + 1;                       // as in _edgeGeomH: the path starts/ends on the port surface
    const T  = this._flipped ? (p => ({ x: p.y, y: p.x })) : (p => p);   // display ↔ model: transpose, or nothing
    const m1 = T(p1), m2 = T(p2);
    const segs = DAGEditor._routeSegments({ x: m1.x + PR, y: m1.y }, { x: m2.x - PR, y: m2.y }, waypoints);
    return segs && segs.map(sg => ({ s: T(sg.s), c1: T(sg.c1), c2: T(sg.c2), e: T(sg.e) }));
  }

  /* The curve of a routed edge, in model coordinates, from s to e through the lane centres in
   * `waypoints` (each at a column's centre). Across each column the curve is flat, at the lane's height,
   * so it never leaves the lane while it is among that column's nodes; the rise or fall from one lane to
   * the next happens in the gap between columns, which holds no nodes. Each piece is a cubic with
   * horizontal handles, so the curve is smooth where it joins. Null if the points do not run left to right. */
  static _routeSegments(s, e, waypoints) {
    const half = DAGEditor._NODE_W / 2;
    const pts = [s];
    for (const w of waypoints) pts.push({ x: w.x - half, y: w.y }, { x: w.x + half, y: w.y });
    pts.push(e);
    for (let i = 1; i < pts.length; i++) if (!(pts[i].x > pts[i - 1].x)) return null;
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], h = (b.x - a.x) / 2;
      segs.push({ s: a, c1: { x: a.x + h, y: a.y }, c2: { x: b.x - h, y: b.y }, e: b });
    }
    return segs;
  }

  /* A point on one cubic segment, at parameter t. */
  static _cubicAt(sg, t) {
    const m = 1 - t;
    return {
      x: m*m*m*sg.s.x + 3*m*m*t*sg.c1.x + 3*m*t*t*sg.c2.x + t*t*t*sg.e.x,
      y: m*m*m*sg.s.y + 3*m*m*t*sg.c1.y + 3*m*t*t*sg.c2.y + t*t*t*sg.e.y,
    };
  }

  _edgeHitTest(edge, gx, gy, tol = 7, valid = this._routesValid()) {
    const segs = this._edgeSegments(edge, valid);
    if (!segs) return false;
    for (const sg of segs) {
      for (let t = 0; t <= 1; t += 0.05) {
        const b = DAGEditor._cubicAt(sg, t);
        if (Math.hypot(gx - b.x, gy - b.y) < tol) return true;
      }
    }
    return false;
  }

  _edgeP1(edge) {
    const node = this._nodes.get(edge.fromNodeId);
    return node ? (this._outputPortPos(node, edge.fromPortId) ?? this._firstOutputPos(node)) : null;
  }

  _edgeP2(edge) {
    const node = this._nodes.get(edge.toNodeId);
    return node ? (this._inputPortPos(node, edge.toPortId) ?? this._firstInputPos(node)) : null;
  }

  /* Compute the full edge geometry from port centres p1 (output) → p2 (input).
   *
   * Returns { sx, sy, cx1, cy1, cx2, cy2, ex, ey } where:
   *   • (sx,sy) is the path start on the port surface
   *   • (ex,ey) is the path end, pulled back by arrowhead length
   *   • control points give a smooth curve
   *
   * Shallow (|dy| ≤ |dx|):
   *   Start/end horizontally offset by PORT_R from port centre.
   *   Handles are horizontal, length = max(30, Δx * 0.35).
   *
   * Steep (|dy| > |dx|):
   *   Start/end diagonally offset by PORT_R at 45° from port centre,
   *   so the path visibly departs/arrives at 45°.
   *   Handles are diagonal (equal x and y), length = max(30, |dy| * 0.35).
   */
  _edgeGeomH(p1, p2) {
    const PR    = DAGEditor._PORT_R + 1;   // +1 = half the 2px port stroke-width
    const ARROW = 8;
    const D45   = PR / Math.SQRT2;   // PR projected onto each axis at 45°

    const adx  = Math.abs(p2.x - p1.x);
    const ady  = Math.abs(p2.y - p1.y);
    const sign = p2.y >= p1.y ? 1 : -1;

    let sx, sy, ex, ey, cx1, cy1, cx2, cy2;

    if (ady > adx) {
      // Steep: depart/arrive at 45°.
      // Path starts/ends at the port surface offset diagonally.
      // Arrowhead tip (refX=8) lands at (ex,ey) = port surface; tail extends back ARROW px.
      const A45 = ARROW / Math.SQRT2;   // ARROW projected onto each axis at 45°
      const pull = Math.max(30, ady * 0.35);
      sx  = p1.x + D45;             sy  = p1.y + sign * D45;
      ex  = p2.x - D45;             ey  = p2.y - sign * D45;   // tip on port surface
      cx1 = sx + pull;              cy1 = sy + sign * pull;
      cx2 = ex - pull - A45;        cy2 = ey - sign * (pull + A45);
    } else {
      // Shallow: depart/arrive horizontally.
      // Arrowhead tip lands at p2.x - PR (port surface).
      const pull = Math.max(30, adx * 0.35);
      sx  = p1.x + PR;              sy  = p1.y;
      ex  = p2.x - PR;              ey  = p2.y;    // tip on port surface
      cx1 = sx + pull;              cy1 = sy;
      cx2 = ex - pull - ARROW;      cy2 = ey;      // control point behind arrowhead
    }

    return { sx, sy, cx1, cy1, cx2, cy2, ex, ey };
  }

  /* Edge geometry for what is drawn. Flipped, the flow runs downwards, so work out the same
   * curve with the axes swapped (it leaves an output heading down, enters an input heading
   * down, and takes the 45° line when it is more sideways than down) and swap the result back. */
  _edgeGeom(p1, p2) {
    if (!this._flipped) return this._edgeGeomH(p1, p2);
    const g = this._edgeGeomH({ x: p1.y, y: p1.x }, { x: p2.y, y: p2.x });
    return { sx: g.sy, sy: g.sx, cx1: g.cy1, cy1: g.cx1, cx2: g.cy2, cy2: g.cx2, ex: g.ey, ey: g.ex };
  }

  /* Kept for the layout repulsion sampler which passes raw port-centre points. */
  _edgeControlPoints(p1, p2) {
    const g = this._edgeGeom(p1, p2);
    return { cx1: g.cx1, cy1: g.cy1, cx2: g.cx2, cy2: g.cy2 };
  }

  _bezierAt(p1, p2, t) {
    const { sx, sy, cx1, cy1, cx2, cy2, ex, ey } = this._edgeGeom(p1, p2);
    const mt = 1 - t;
    return {
      x: mt*mt*mt*sx + 3*mt*mt*t*cx1 + 3*mt*t*t*cx2 + t*t*t*ex,
      y: mt*mt*mt*sy + 3*mt*mt*t*cy1 + 3*mt*t*t*cy2 + t*t*t*ey,
    };
  }

  _edgePath(edge, valid = this._routesValid()) {
    const segs = this._edgeSegments(edge, valid);
    if (!segs) return '';
    const at = p => `${p.x},${p.y}`;
    return `M${at(segs[0].s)}` + segs.map(sg => ` C${at(sg.c1)} ${at(sg.c2)} ${at(sg.e)}`).join('');
  }

  /* ─────────────────── node / edge operations ─────────────────── */
  _nextNodeId() { return `n${++this._nodeSeq}`; }
  _nextEdgeId() { return `e${++this._edgeSeq}`; }

  _makeDefaultPorts() {
    return {
      inputs:  [{ id: 'in',  label: '' }],
      outputs: [{ id: 'out', label: '' }],
    };
  }

  _uniqueLabel(base) {
    const existing = new Set([...this._nodes.values()].map(n => n.label));
    if (!existing.has(base)) return base;
    let n = 2;
    while (existing.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  _createNodeAt(x, y, opts = {}) {
    const id   = opts.id ?? this._nextNodeId();
    const node = new DAGNode({
      id,
      label:   opts.label   ?? this._uniqueLabel('Node'),
      x, y,
      inputs:  opts.inputs  ?? this._makeDefaultPorts().inputs,
      outputs: opts.outputs ?? this._makeDefaultPorts().outputs,
    });
    this._nodes.set(id, node);
    this._setSelected('node', id);
    this._snapshot();
    this._render();
    this._onChange({ type: 'created', node });
    return node;
  }

  /* Model top-left of a node (unflipped height hu) whose centre is at display point (gx, gy). */
  _modelTopLeftForCentre(gx, gy, hu) {
    const W = DAGEditor._NODE_W;
    return this._flipped ? { x: gy - W / 2, y: gx - hu / 2 }      // display x ↔ model y
                         : { x: gx - W / 2, y: gy - hu / 2 };
  }

  /* Create a node whose CENTRE is at the display point (gx, gy), whatever the orientation
   * (_createNodeAt itself takes the node's top-left in model coordinates). */
  _createNodeAtDisplay(gx, gy, opts = {}) {
    const label   = opts.label   ?? this._uniqueLabel('Node');
    const inputs  = opts.inputs  ?? this._makeDefaultPorts().inputs;
    const outputs = opts.outputs ?? this._makeDefaultPorts().outputs;
    const probe   = new DAGNode({ id: '\u0000probe', label, inputs, outputs });   // to learn its height
    const p = this._modelTopLeftForCentre(gx, gy, this._nodeHeight(probe));
    return this._createNodeAt(p.x, p.y, { ...opts, label, inputs, outputs });
  }

  _createNodeAtCenter() {
    const r  = this._svgRect();
    const gp = this._clientToGraph(r.left + r.width / 2, r.top + r.height / 2);
    const off = this._nodes.size * 24 % 160;
    return this._createNodeAtDisplay(gp.x + off, gp.y + off);
  }

  _tryAddEdge(fromNodeId, fromPortId, toNodeId, toPortId) {
    if (fromNodeId === toNodeId) return false;
    for (const e of this._edges.values()) {
      if (e.fromNodeId === fromNodeId && e.fromPortId === fromPortId &&
          e.toNodeId   === toNodeId   && e.toPortId   === toPortId) return false;
    }
    if (this._wouldCreateCycle(fromNodeId, toNodeId)) {
      this._hint.textContent = '⚠ Cannot add edge — would create a cycle.';
      setTimeout(() => this._resetHint(), 2000);
      return false;
    }
    const id   = this._nextEdgeId();
    const edge = new DAGEdge({ id, fromNodeId, fromPortId, toNodeId, toPortId });
    this._edges.set(id, edge);
    this._snapshot();
    this._render();
    this._onChange({ type: 'edge-created', edge });
    this._triggerPinnedLayout();
    return true;
  }

  _wouldCreateCycle(from, to) {
    const visited = new Set(), stack = [to];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === from) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const e of this._edges.values()) if (e.fromNodeId === cur) stack.push(e.toNodeId);
    }
    return false;
  }

  _deleteSelected() {
    if (!this._selected) return;
    const { kind, id } = this._selected;
    if (kind === 'node') {
      const node = this._nodes.get(id);

      // Collect edges touching this node
      const inEdges  = [];  // edges arriving   at this node's input port
      const outEdges = [];  // edges leaving from this node's output port
      const removedEdges = [];
      for (const [eid, e] of this._edges) {
        if (e.toNodeId   === id) inEdges.push(e);
        if (e.fromNodeId === id) outEdges.push(e);
        if (e.fromNodeId === id || e.toNodeId === id) {
          removedEdges.push(e);
          this._edges.delete(eid);
        }
      }

      this._nodes.delete(id);
      this._setSelected(null, null);

      // Bridge: if node has exactly one input port and one output port,
      // reconnect every upstream source directly to every downstream target.
      const bridgeEdges = [];
      if (node && node.inputs.length === 1 && node.outputs.length === 1) {
        for (const ie of inEdges) {
          for (const oe of outEdges) {
            // Skip if it would be a self-loop or duplicate or cycle
            if (ie.fromNodeId === oe.toNodeId) continue;
            const alreadyExists = [...this._edges.values()].some(
              ex => ex.fromNodeId === ie.fromNodeId && ex.fromPortId === ie.fromPortId &&
                    ex.toNodeId   === oe.toNodeId   && ex.toPortId   === oe.toPortId);
            if (alreadyExists) continue;
            if (this._wouldCreateCycle(ie.fromNodeId, oe.toNodeId)) continue;
            const eid  = this._nextEdgeId();
            const edge = new DAGEdge({
              id: eid,
              fromNodeId: ie.fromNodeId, fromPortId: ie.fromPortId,
              toNodeId:   oe.toNodeId,   toPortId:   oe.toPortId,
            });
            this._edges.set(eid, edge);
            bridgeEdges.push(edge);
          }
        }
      }

      this._snapshot(); this._render();
      for (const e of removedEdges) this._onChange({ type: 'edge-deleted', edge: e });
      if (node) this._onChange({ type: 'deleted', node });
      for (const e of bridgeEdges) this._onChange({ type: 'edge-created', edge: e });
      this._triggerPinnedLayout();
    } else if (kind === 'edge') {
      const edge = this._edges.get(id);
      this._edges.delete(id);
      this._setSelected(null, null);
      this._snapshot(); this._render();
      if (edge) this._onChange({ type: 'edge-deleted', edge });
      this._triggerPinnedLayout();
    }
  }

  _setSelected(kind, id) {
    const prev     = this._selected;
    const prevNode = prev?.kind === 'node' ? this._nodes.get(prev.id) : null;
    this._selected = kind ? { kind, id } : null;
    this._render();
    // A node stops being selected when selection moves elsewhere or is cleared
    if (prevNode && !(kind === 'node' && id === prev.id)) {
      this._onChange({ type: 'deselected', node: prevNode });
    }
    if (kind === 'node') {
      const node = this._nodes.get(id);
      if (node) this._onChange({ type: 'selected', node });
    }
  }

  _selectNextNode(dir) {
    const ids = [...this._nodes.keys()];
    if (!ids.length) return;
    const cur = this._selected?.kind === 'node' ? this._selected.id : null;
    const idx = cur ? ids.indexOf(cur) : -1;
    this._setSelected('node', ids[(idx + dir + ids.length) % ids.length]);
  }

  /* ─────────────────── fit view ─────────────────── */
  _fitView() {
    if (!this._nodes.size) return;
    const pad = 60;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this._nodes.values()) {
      const b = this._boxOf(n);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    const r = this._svgRect();
    const scaleX = (r.width  - pad * 2) / (maxX - minX || 1);
    const scaleY = (r.height - pad * 2) / (maxY - minY || 1);
    this._scale  = Math.min(2, Math.max(0.15, Math.min(scaleX, scaleY)));
    this._viewX  = (r.width  - (maxX - minX) * this._scale) / 2 - minX * this._scale;
    this._viewY  = (r.height - (maxY - minY) * this._scale) / 2 - minY * this._scale;
    this._applyTransform(); this._render();
  }

  /* ─────────────────── undo / redo ─────────────────── */
  _snapshot(coalesceKey = null) {
    const snap = this._serialise();
    if (coalesceKey && coalesceKey === this._lastSnapKey && this._undoStack.length > 1) {
      // Same field edited again (e.g. typing in a label): fold into one undo step
      this._undoStack[this._undoStack.length - 1] = snap;
    } else {
      this._undoStack.push(snap);
      if (this._undoStack.length > 100) this._undoStack.shift();
    }
    this._lastSnapKey = coalesceKey;
    this._redoStack = [];
  }

  _serialise() {
    return JSON.stringify({
      nodes:   [...this._nodes.values()].map(n => n.toJSON()),
      edges:   [...this._edges.values()].map(e => e.toJSON()),
      nodeSeq: this._nodeSeq,
      edgeSeq: this._edgeSeq,
    });
  }

  _restore(snap) {
    const s = JSON.parse(snap);
    this._setSelected(null, null);   // while the old nodes still exist, so listeners hear 'deselected'
    this._nodes.clear(); this._edges.clear();
    s.nodes.forEach(n => this._nodes.set(n.id, DAGNode.fromJSON(n)));
    s.edges.forEach(e => this._edges.set(e.id, DAGEdge.fromJSON(e)));
    this._nodeSeq = s.nodeSeq; this._edgeSeq = s.edgeSeq;
    this._selected = null; this._render();
  }

  undo() {
    if (this._undoStack.length < 2) return;          // index 0 is the baseline
    this._redoStack.push(this._undoStack.pop());
    this._lastSnapKey = null;
    this._restore(this._undoStack[this._undoStack.length - 1]);
  }

  redo() {
    if (!this._redoStack.length) return;
    const snap = this._redoStack.pop();
    this._undoStack.push(snap);
    this._lastSnapKey = null;
    this._restore(snap);
  }

  _resetHint() {
    this._hint.textContent = 'Click canvas to add a node · Drag a port to draw an edge · Drop on canvas to auto-create a node · Del to delete';
  }

  /* ─────────────────── render ─────────────────── */
  _render() { this._renderEdges(); this._renderNodes(); this._applyTransform(); }

  _renderEdges() {
    const existing = new Set(this._edges.keys());
    for (const el of [...this._gEdges.children]) {
      if (el === this._draftLine) continue;
      if (!existing.has(el.dataset.id)) el.remove();
    }
    const valid = this._routesValid();              // one check for every edge
    for (const edge of this._edges.values()) {
      const sel = this._selected?.kind === 'edge' && this._selected.id === edge.id;
      let el = this._gEdges.querySelector(`[data-id="${edge.id}"]`);
      if (!el) {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        el.dataset.id = edge.id;
        el.setAttribute('fill', 'none');
        this._gEdges.appendChild(el);
      }
      el.setAttribute('d', this._edgePath(edge, valid));
      el.setAttribute('class', sel ? 'dag-edge dag-edge--selected' : 'dag-edge');
      el.setAttribute('marker-end', sel ? 'url(#dag-arrow-sel)' : 'url(#dag-arrow)');
    }
  }

  _renderNodes() {
    const existing = new Set(this._nodes.keys());
    for (const el of [...this._gNodes.children]) {
      if (!existing.has(el.dataset.id)) el.remove();
    }

    const RX = DAGEditor._NODE_RX;
    const PR = DAGEditor._PORT_R;
    const LH = DAGEditor._LINE_H;
    const SVGNS = 'http://www.w3.org/2000/svg';
    const flipped = this._flipped;

    for (const [key, c] of [...this._lineCache]) if (!this._nodes.has(c.id)) this._lineCache.delete(key);
    for (const id of [...this._flipCache.keys()]) if (!this._nodes.has(id)) this._flipCache.delete(id);

    for (const node of this._nodes.values()) {
      const compact = this._isCompact(node);
      const f       = flipped ? this._flipGeom(node) : null;
      const box     = this._boxOf(node, f);
      const W = box.w, H = box.h;
      const sel     = this._selected?.kind === 'node' && this._selected.id === node.id;

      let g = this._gNodes.querySelector(`[data-id="${node.id}"]`);
      if (!g) {
        g = document.createElementNS(SVGNS, 'g');
        g.dataset.id = node.id;
        this._gNodes.appendChild(g);
      }

      g.setAttribute('transform', `translate(${box.x},${box.y})`);
      g.setAttribute('class', `dag-node${sel ? ' dag-node--selected' : ''}${compact ? ' dag-node--compact' : ''}`);

      // background rect
      let rect = g.querySelector('rect.dag-node-bg');
      if (!rect) {
        rect = document.createElementNS(SVGNS, 'rect');
        rect.setAttribute('class', 'dag-node-bg');
        rect.setAttribute('rx', RX); rect.setAttribute('ry', RX);
        g.prepend(rect);
      }
      rect.setAttribute('width', W); rect.setAttribute('height', H);

      // label — wrapped onto several lines. Unflipped: centred vertically in a compact node, at the
      // top (above the divider) in an expanded one. Flipped: centred between the port-label zones.
      let labelEl = g.querySelector('text.dag-node-label');
      if (!labelEl) {
        labelEl = document.createElementNS(SVGNS, 'text');
        labelEl.setAttribute('class', 'dag-node-label');
        labelEl.setAttribute('dominant-baseline', 'middle');
        labelEl.setAttribute('text-anchor', 'middle');
        g.appendChild(labelEl);
      }
      const lines  = this._labelLines(node);
      const firstY = flipped ? (f.top + (H - f.bottom)) / 2 - (lines.length - 1) * LH / 2
                   : compact ? H / 2 - (lines.length - 1) * LH / 2 : 18;
      const lkey   = lines.join('\n');
      if (labelEl.dataset.lines !== lkey) {
        labelEl.replaceChildren();
        for (const line of lines) {
          const t = document.createElementNS(SVGNS, 'tspan');
          t.setAttribute('dominant-baseline', 'middle');
          t.textContent = line;
          labelEl.appendChild(t);
        }
        labelEl.dataset.lines = lkey;
      }
      [...labelEl.children].forEach((t, i) => { t.setAttribute('x', W / 2); t.setAttribute('y', firstY + i * LH); });

      // dividers — expanded nodes only. Unflipped: one under the header. Flipped: one under the
      // port labels on the top edge and one above those on the bottom edge (where there are ports).
      const dividerYs = [];
      if (!compact) {
        if (!flipped) dividerYs.push(this._headerHeight(node) - 6);
        else {
          if (node.inputs.length)  dividerYs.push(f.top);
          if (node.outputs.length) dividerYs.push(H - f.bottom);
        }
      }
      const dividers = [...g.querySelectorAll('line.dag-node-divider')];
      dividerYs.forEach((y, i) => {
        let d = dividers[i];
        if (!d) {
          d = document.createElementNS(SVGNS, 'line');
          d.setAttribute('class', 'dag-node-divider');
          g.appendChild(d);
        }
        d.setAttribute('x1', 0); d.setAttribute('y1', y);
        d.setAttribute('x2', W); d.setAttribute('y2', y);
        d.style.display = '';
      });
      dividers.slice(dividerYs.length).forEach(d => { d.style.display = 'none'; });

      // ports
      const keepPorts = new Set();

      const addPort = (port, dir, i) => {
        // centre of the dot, relative to the node
        let cx, cy;
        if (flipped) { cx = (dir === 'in' ? f.inX : f.outX)[i]; cy = dir === 'in' ? 0 : H; }
        else         { cx = dir === 'in' ? 0 : W; cy = this._portLocalY(node, dir === 'in' ? 'input' : 'output', i); }

        const pid = `${port.id}:${dir}`;
        keepPorts.add(pid);
        let circle = g.querySelector(`circle[data-port-uid="${pid}"]`);
        if (!circle) {
          circle = document.createElementNS(SVGNS, 'circle');
          circle.dataset.portUid = pid;
          circle.dataset.portId  = port.id;
          circle.dataset.portDir = dir;
          circle.setAttribute('class', `dag-port dag-port-${dir}`);
          circle.setAttribute('r', PR);
          g.appendChild(circle);
        }
        circle.setAttribute('cx', cx); circle.setAttribute('cy', cy);

        // port label: shown in expanded mode always; in compact mode only if non-empty.
        const lid        = `label:${pid}`;
        const hasLabel   = !!(port.label);
        const showLabel  = !compact || hasLabel;
        keepPorts.add(lid);
        let lbl = g.querySelector(`text[data-port-uid="${lid}"]`);
        if (showLabel) {
          if (!lbl) {
            lbl = document.createElementNS(SVGNS, 'text');
            lbl.dataset.portUid = lid;
            lbl.setAttribute('class', `dag-port-label dag-port-label-${dir}`);
            lbl.setAttribute('dominant-baseline', 'middle');
            g.appendChild(lbl);
          }
          if (!flipped) {
            // inside the body: input labels right of the port dot, output labels left of it
            lbl.setAttribute('text-anchor', dir === 'in' ? 'start' : 'end');
            lbl.setAttribute('x', dir === 'in' ? PR + 4 : W - PR - 4);
            lbl.setAttribute('y', cy);
            lbl.removeAttribute('transform');
          } else {
            // upright, just inside the edge, under (or over) its port
            lbl.setAttribute('text-anchor', 'middle');
            lbl.setAttribute('x', cx);
            lbl.setAttribute('y', dir === 'in' ? 14 : H - 14);
            lbl.removeAttribute('transform');
          }
          lbl.textContent = port.label || '';
          lbl.style.display = '';
        } else if (lbl) {
          lbl.style.display = 'none';
        }
      };

      node.inputs.forEach((port, i)  => addPort(port, 'in', i));
      node.outputs.forEach((port, i) => addPort(port, 'out', i));

      // remove orphaned port elements
      for (const el of [...g.querySelectorAll('[data-port-uid]')]) {
        if (!keepPorts.has(el.dataset.portUid)) el.remove();
      }
    }
  }

  /* ─────────────────── auto-layout ─────────────────── */
  _computeStrata() {
    const nodes = [...this._nodes.keys()];
    const succ  = new Map(nodes.map(id => [id, []]));
    const inDeg = new Map(nodes.map(id => [id, 0]));
    for (const e of this._edges.values()) {
      if (succ.has(e.fromNodeId) && inDeg.has(e.toNodeId)) {
        succ.get(e.fromNodeId).push(e.toNodeId);
        inDeg.set(e.toNodeId, inDeg.get(e.toNodeId) + 1);
      }
    }
    const stratum = new Map(nodes.map(id => [id, 0]));
    const queue   = nodes.filter(id => inDeg.get(id) === 0);
    while (queue.length) {
      const id = queue.shift();
      for (const nxt of succ.get(id)) {
        const s = stratum.get(id) + 1;
        if (s > stratum.get(nxt)) stratum.set(nxt, s);
        inDeg.set(nxt, inDeg.get(nxt) - 1);
        if (inDeg.get(nxt) === 0) queue.push(nxt);
      }
    }
    return stratum;
  }

  _updateLayoutBtn() {
    const btn = this._toolbar.querySelector('[data-action="layout"]');
    if (!btn) return;
    btn.classList.toggle('dag-btn-layout--on',     this._layoutActive || this._layoutPinned);
    btn.classList.toggle('dag-btn-layout--pinned', this._layoutPinned);
    btn.title = this._layoutPinned
      ? 'Auto-layout pinned — double-click to unpin (L)'
      : 'Toggle auto-layout — double-click to pin (L)';
  }

  /* Trigger a layout run when the graph changes in pinned mode. */
  _triggerPinnedLayout() {
    if (!this._layoutPinned) return;
    if (this._layoutActive) {
      // Already running: head for the new arrangement and allow a full run from now
      this._layoutTargets   = this._computeLayoutTargets();
      this._layoutStartTime = performance.now();
    } else {
      this.autoLayout(true);
    }
  }

  autoLayout(active) {
    this._layoutActive = active;
    this._updateLayoutBtn();
    if (active) {
      this._layoutTargets   = this._computeLayoutTargets();
      this._layoutStartTime = this._layoutLastTime = performance.now();
      this._layoutTick();
    } else {
      if (this._layoutRaf) { cancelAnimationFrame(this._layoutRaf); this._layoutRaf = null; }
      this._snapshot();
    }
  }

  /* ── Layered layout ──────────────────────────────────────────────────────
   * Works out where every node should end up (the animation then glides there):
   *   1. strata (columns): longest path from a root, roots on the left;
   *   2. an invisible "dummy" vertex in every column an edge passes through between its ends,
   *      so the edge gets its own lane between nodes instead of cutting across one. Each edge's
   *      dummies, joined up, are its route (see _routeSegments);
   *   3. order within each column by barycentre sweeps, which minimises crossings
   *      (edges are placed by port, so a node's ports are ordered too);
   *   4. vertical placement: each vertex is pulled to line up with the ports it is
   *      connected to, subject to a hard minimum gap, so nodes can never overlap;
   *   5. refinement: neighbouring items in a column are swapped when that gives
   *      fewer edges cutting through nodes (and fewer crossings) once re-placed.
   * Deterministic: the same graph and arrangement always give the same result. The columns never
   * depend on where the nodes start; the order within a column starts from the current vertical
   * order (so small edits don't reshuffle a layout you already have) and is then improved. */
  _computeLayoutTargets() {
    const targets = new Map();
    const nodes = [...this._nodes.values()];
    this._routes = null;
    if (!nodes.length) return targets;

    const W = DAGEditor._NODE_W, GAP = DAGEditor._LAYOUT_NODE_GAP;
    // The layout is worked out in model (unflipped) coordinates, but the same positions are shown
    // flipped when the container is taller than wide, where a node's width runs along its column
    // and its height across the columns. So leave room for the larger of the two in each direction.
    const flipH = Math.max(0, ...nodes.map(n => this._flipGeom(n).h));
    const COL = Math.max(W + DAGEditor._LAYOUT_COL_GAP, flipH + GAP);
    // A lane is only as tall as the route it carries: the route runs flat across the column (see
    // _routeSegments), and only rises or falls in the gap between columns, which holds no nodes.
    const DUMMY_H = 6, DUMMY_PAD = 8;
    const stratum = this._computeStrata();
    const smooth = t => t * t * (3 - 2 * t);     // the curve's height profile along its run

    // 1–2. vertices and the segments between neighbouring columns
    const layers = [];
    const add = v => { v.ins = []; v.outs = []; (layers[v.layer] = layers[v.layer] || []).push(v); return v; };
    const real = new Map();
    const routedEdges = [];          // every edge running from one column to a later one, with its route
    const PORT_END = DAGEditor._PORT_R + 1;
    for (const n of nodes) {
      const hu    = this._nodeHeight(n);
      const h     = Math.max(hu, this._flipGeom(n).w);     // room it needs along the column, either way up
      const shift = (h - hu) / 2;                          // the node sits in the middle of that room
      real.set(n.id, add({ node: n, layer: stratum.get(n.id) ?? 0, h, shift, pad: GAP / 2, w: 4, key: n.y + hu / 2 }));
    }
    // A segment joins vertices a → b in neighbouring columns; aOff / bOff are the heights of the
    // attachment points below each vertex's top (null = the middle, used by dummies).
    const segment = (a, aOff, b, bOff) => { const g = { a, aOff, b, bOff }; a.outs.push(g); b.ins.push(g); };
    for (const e of this._edges.values()) {
      const u = real.get(e.fromNodeId), v = real.get(e.toNodeId);
      if (!u || !v || v.layer <= u.layer) continue;
      const fi = u.node.outputs.findIndex(p => p.id === e.fromPortId);
      const ti = v.node.inputs.findIndex(p => p.id === e.toPortId);
      const fo = fi < 0 ? u.h / 2 : this._portLocalY(u.node, 'output', fi) + u.shift;
      const to = ti < 0 ? v.h / 2 : this._portLocalY(v.node, 'input', ti) + v.shift;
      // horizontal run of the curve, port to port; each dummy sits at its column's centre
      const xs = u.layer * COL + W, run = v.layer * COL - xs;
      const routed = { edge: e, u, fo, v, to, chain: [] };     // route = the dummies in the columns between
      routedEdges.push(routed);
      // Where the curve is now: ends at the ports as they currently sit. A lane's starting position is
      // the curve's height at its column, so a graph that is already laid out is read back in the
      // order it was laid out in (laying it out again then leaves it alone).
      const y0 = u.node.y + fo - u.shift, y1 = v.node.y + to - v.shift;
      let prev = u, prevOff = fo;
      const chain = routed.chain;
      for (let l = u.layer + 1; l < v.layer; l++) {
        const f = (l * COL + W / 2 - xs) / run;
        const d = add({ dummy: true, layer: l, h: DUMMY_H, pad: DUMMY_PAD, w: 1, key: y0 + (y1 - y0) * smooth(f),
                        edge: { u, fo, v, to }, f });
        segment(prev, prevOff, d, null);
        chain.push(d);
        prev = d; prevOff = null;
      }
      segment(prev, prevOff, v, to);
    }
    const L = layers.length;
    for (let l = 0; l < L; l++) layers[l] = layers[l] || [];

    // Work budgets: the ordering and refinement below get cheaper-but-shallower as the graph grows,
    // so laying out a big graph never freezes the page (small graphs get the full effort).
    const segCount  = layers.slice(0, -1).map(layer => layer.reduce((n, v) => n + v.outs.length, 0));
    const crossCost = segCount.reduce((n, c) => n + c * c / 2, 0);     // one crossing count
    const nVertices = layers.reduce((n, l) => n + l.length, 0);
    const nSegments = segCount.reduce((n, c) => n + c, 0);
    const nStarts   = nVertices <= 90 ? 12 : nVertices <= 220 ? 4 : 1; // attempts made; the best is kept
    const sweeps    = Math.max(2, Math.min(24, Math.floor(4e6 / (crossCost + 1) / nStarts)));
    const perTrial  = 10 * (nVertices + nSegments) + crossCost + 300 * routedEdges.length;
    const trials    = Math.min(400, Math.floor(2.5e6 / perTrial / nStarts));
    const everything = layers.flat();

    // 3. ordering: a position along the column for each vertex, refined by port height
    const pos = (v, off) => off === null ? v.order : v.order + (off / v.h - 0.5) * 0.9;
    const layerSegs = layers.slice(0, -1).map(layer => layer.flatMap(v => v.outs));   // fixed: only positions change
    const crossings = () => {
      let c = 0;
      for (const segs of layerSegs) {
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i], sa = pos(s.a, s.aOff), sb = pos(s.b, s.bOff);
          for (let j = i + 1; j < segs.length; j++) {
            const t = segs[j];
            if ((sa - pos(t.a, t.aOff)) * (sb - pos(t.b, t.bOff)) < 0) c++;
          }
        }
      }
      return c;
    };
    const reorder = (layer, fromLeft) => {
      const val = new Map();
      for (const v of layer) {
        const segs = fromLeft ? v.ins : v.outs;
        val.set(v, segs.length
          ? segs.reduce((sum, g) => sum + (fromLeft ? pos(g.a, g.aOff) : pos(g.b, g.bOff)), 0) / segs.length
          : v.order);
      }
      layer.sort((p, q) => (val.get(p) - val.get(q)) || (p.order - q.order));
      layer.forEach((v, i) => { v.order = i; });
    };

    // 4. vertical placement
    const sep = (a, b) => a.h + a.pad + b.pad;                     // least distance between the tops of a, then b
    const place = layer => {            // weighted isotonic regression: closest positions that respect the gaps
      const n = layer.length;
      if (!n) return;
      for (const v of layer) if (v.dummy) {        // the height the route ideally has in this column
        const { u, fo, v: tv, to } = v.edge;
        const y0 = u.y + fo, dy = tv.y + to - y0;
        v.mid  = y0 + dy * smooth(v.f);
      }
      const off = [0];
      for (let i = 1; i < n; i++) off[i] = off[i - 1] + sep(layer[i - 1], layer[i]);
      const blocks = [];
      layer.forEach((v, i) => {
        const segs = v.ins.length + v.outs.length;
        let want = v.y;                                            // unconnected: stay put
        if (v.dummy) want = v.mid - v.h / 2;                       // centred on the curve
        else if (segs) {                                           // line up with every connected port
          let sum = 0;
          for (const g of v.ins)  sum += g.a.y + (g.aOff === null ? g.a.h / 2 : g.aOff) - g.bOff;
          for (const g of v.outs) sum += g.b.y + (g.bOff === null ? g.b.h / 2 : g.bOff) - g.aOff;
          want = sum / segs;
        }
        let blk = { w: v.w, sum: v.w * (want - off[i]), n: 1 };
        while (blocks.length && blocks[blocks.length - 1].sum / blocks[blocks.length - 1].w > blk.sum / blk.w) {
          const p = blocks.pop();
          blk = { w: p.w + blk.w, sum: p.sum + blk.sum, n: p.n + blk.n };
        }
        blocks.push(blk);
      });
      let i = 0;
      for (const b of blocks) { const z = b.sum / b.w; for (let k = 0; k < b.n; k++, i++) layer[i].y = z + off[i]; }
    };
    const settle = iterations => {
      for (let it = 0; it < iterations; it++) {
        if (it % 2 === 0) for (let l = 0; l < L; l++) place(layers[l]);
        else for (let l = L - 1; l >= 0; l--) place(layers[l]);
      }
    };

    // 5. refinement. Routes are drawn from the lanes as they finally sit, and a node can still end up
    //    where a route runs through it (the ordering above ignores node heights), so count the routes
    //    that really cut through a node and try swapping neighbours to reduce them.
    const cutThrough = () => {
      let hits = 0;
      for (const { u, fo, v, to, chain } of routedEdges) {
        const segs = DAGEditor._routeSegments(
          { x: u.layer * COL + W + PORT_END, y: u.y + fo },
          { x: v.layer * COL - PORT_END,     y: v.y + to },
          chain.map(d => ({ x: d.layer * COL + W / 2, y: d.y + d.h / 2 })));
        if (!segs) { hits++; continue; }                                  // cannot be drawn at all
        const N = 12, pts = [];
        let lo = Infinity, hi = -Infinity;
        for (const sg of segs) for (let k = 0; k <= N; k++) {
          const q = DAGEditor._cubicAt(sg, k / N);
          pts.push(q); lo = Math.min(lo, q.y); hi = Math.max(hi, q.y);
        }
        for (let l = u.layer + 1; l < v.layer; l++) {
          const x0 = l * COL;
          for (const n of layers[l]) {
            if (n.dummy || n.y > hi + 2 || n.y + n.h < lo - 2) continue;   // cannot touch it
            for (const q of pts) {
              if (q.x > x0 - 2 && q.x < x0 + W + 2 && q.y > n.y - 2 && q.y < n.y + n.h + 2) { hits++; break; }
            }
          }
        }
      }
      return hits;
    };
    const score = () => 3 * cutThrough() + crossings();
    // How far the edges are from level: the total vertical distance between the two ends of every
    // segment. It breaks ties between equally good attempts, in favour of the straighter (and so
    // more compact) one.
    const bend = () => {
      let total = 0;
      for (const segs of layerSegs) for (const g of segs) {
        const ya = g.a.y + (g.aOff === null ? g.a.h / 2 : g.aOff), yb = g.b.y + (g.bOff === null ? g.b.h / 2 : g.bOff);
        total += Math.abs(ya - yb);
      }
      return total;
    };

    // One complete attempt, from a given starting order: order the columns, place, refine.
    const attempt = (keyOf, withSweeps = true) => {
      for (const layer of layers) {
        layer.sort((p, q) => (keyOf(p) - keyOf(q)) || (p.key - q.key));
        layer.forEach((v, i) => { v.order = i; });
      }
      let bestOrder = layers.map(l => l.slice()), bestCrossings = crossings();
      for (let it = 0; withSweeps && it < sweeps && bestCrossings > 0; it++) {
        if (it % 2 === 0) for (let l = 1; l < L; l++) reorder(layers[l], true);
        else for (let l = L - 2; l >= 0; l--) reorder(layers[l], false);
        const c = crossings();
        if (c < bestCrossings) { bestCrossings = c; bestOrder = layers.map(l => l.slice()); }
      }
      layers.forEach((layer, i) => { layer.splice(0, layer.length, ...bestOrder[i]); layer.forEach((v, k) => { v.order = k; }); });

      for (const layer of layers) {                                // start: packed and centred on y = 0
        layer.forEach((v, i) => { v.y = i ? layer[i - 1].y + sep(layer[i - 1], v) : 0; });
        const last = layer[layer.length - 1];
        const mid  = last ? (last.y + last.h) / 2 : 0;
        layer.forEach(v => { v.y -= mid; });
      }
      settle(30);

      let bestScore = score(), budget = trials;                    // bounded, so big graphs stay fast
      const saved = new Array(everything.length);
      for (let round = 0; round < 3 && bestScore > 0 && budget > 0; round++) {
        let improved = false;
        for (const layer of layers) {
          for (let i = 0; i + 1 < layer.length && budget > 0; i++, budget--) {
            for (let k = 0; k < everything.length; k++) saved[k] = everything[k].y;
            const swap = () => { [layer[i], layer[i + 1]] = [layer[i + 1], layer[i]]; layer[i].order = i; layer[i + 1].order = i + 1; };
            swap();
            settle(10);
            const sc = score();
            if (sc < bestScore) { bestScore = sc; improved = true; }
            else { swap(); everything.forEach((v, k) => { v.y = saved[k]; }); }
          }
        }
        if (!improved) break;
      }
      settle(30);
      return { score: score(), bend: bend() };
    };

    // Try several starting orders and keep the best result: fewest cut-throughs and crossings, then
    // straightest. An attempt only wins by being strictly better, so earlier ones win ties.
    //   - the current vertical order exactly as it is (no sweeps), so a layout that is already good stays;
    //   - the current order with crossing-reduction sweeps, and its reverse;
    //   - seeded shuffles (so it is repeatable), which rescue the cases where the current order is a poor start.
    // Then the best result is taken as the new "current" arrangement and the first three are tried again
    // from there, until nothing improves. So a layout is always a fixed point of itself: laying it out
    // again changes nothing.
    const shuffle = seed => { let t = seed >>> 0; const r = new Map();
      for (const v of everything) r.set(v, ((t = (t * 1664525 + 1013904223) >>> 0) / 4294967296));
      return v => r.get(v); };
    const fromCurrent = nStarts === 1 ? [[v => v.key, true]]
                      : [[v => v.key, false], [v => v.key, true], [v => -v.key, true]];
    const shuffled = [];
    for (let k = 1; fromCurrent.length + shuffled.length < nStarts; k++) shuffled.push([shuffle(k), true]);

    let best = null;
    const consider = (keyOf, withSweeps) => {
      const r = attempt(keyOf, withSweeps);
      if (!best || r.score < best.score || (r.score === best.score && r.bend < best.bend - 0.5)) {
        best = { ...r, order: layers.map(l => l.slice()), ys: everything.map(v => v.y) };
        return true;
      }
      return false;
    };
    const restore = () => {
      layers.forEach((layer, i) => { layer.splice(0, layer.length, ...best.order[i]); layer.forEach((v, k) => { v.order = k; }); });
      everything.forEach((v, k) => { v.y = best.ys[k]; });
    };
    for (const [keyOf, withSweeps] of [...fromCurrent, ...shuffled]) consider(keyOf, withSweeps);

    for (let round = 0; round < 3 && nStarts > 1; round++) {
      restore();
      for (const v of everything) {                         // read the best arrangement back as positions
        if (!v.dummy) v.key = v.y + v.h / 2;
        else { const { u, fo, v: tv, to } = v.edge, y0 = u.y + fo; v.key = y0 + (tv.y + to - y0) * smooth(v.f); }
      }
      let improved = false;
      for (const [keyOf, withSweeps] of fromCurrent) improved = consider(keyOf, withSweeps) || improved;
      if (!improved) break;
    }
    restore();

    let minY = Infinity;
    for (const v of real.values()) minY = Math.min(minY, v.y + v.shift);
    const cents = n => Math.round(n * 100) / 100;                   // 0.01 px: tidy exports, repeatable results
    for (const [id, v] of real) targets.set(id, { x: cents(v.layer * COL), y: cents(v.y + v.shift - minY) });

    // Routes: through the centre of each lane, at each column's centre, in model coordinates. They are
    // valid for the arrangement this layout is heading for (see _routesValid), so they apply once it lands.
    const paths = new Map();
    for (const { edge, chain } of routedEdges) {
      paths.set(edge.id, chain.map(d => ({ x: cents(d.layer * COL + W / 2), y: cents(d.y + d.h / 2 - minY) })));
    }
    this._routes = { sig: this._geomSig(targets), paths };
    return targets;
  }

  /* One animation frame: glide every node toward its target; always finish by the deadline. */
  _layoutTick() {
    if (!this._layoutActive) return;
    const now     = performance.now();
    const dt      = Math.max(0, Math.min(100, now - this._layoutLastTime));
    this._layoutLastTime = now;
    const expired = now - this._layoutStartTime >= DAGEditor._LAYOUT_DEADLINE;
    const k       = 1 - Math.exp(-dt / DAGEditor._LAYOUT_TAU);

    let maxErr = 0;
    for (const [id, t] of this._layoutTargets) {
      const node = this._nodes.get(id);
      if (!node) continue;
      node.x += (t.x - node.x) * k;
      node.y += (t.y - node.y) * k;
      maxErr = Math.max(maxErr, Math.abs(t.x - node.x), Math.abs(t.y - node.y));
    }
    const settled = expired || maxErr < 0.5;
    if (settled) {                                   // land exactly on the targets
      for (const [id, t] of this._layoutTargets) {
        const node = this._nodes.get(id);
        if (node) { node.x = t.x; node.y = t.y; }
      }
    }

    this._render();
    this._fitView();

    if (settled) { this._layoutActive = false; this._updateLayoutBtn(); this._snapshot(); return; }
    this._layoutRaf = requestAnimationFrame(() => this._layoutTick());
  }

  /* ─────────────────── public API ─────────────────── */

  /**
   * Add a node programmatically.
   * @param {string} label
   * @param {number} [x]  left, in the unflipped orientation (default: the middle of the view)
   * @param {number} [y]  top, in the unflipped orientation
   * @param {object} [opts] - { inputs, outputs } port arrays
   * @returns {DAGNode}
   */
  addNode(label, x, y, opts = {}) {
    const r  = this._svgRect();
    const gp = this._clientToGraph(r.left + r.width / 2, r.top + r.height / 2);
    if (x === undefined && y === undefined) return this._createNodeAtDisplay(gp.x, gp.y, { label, ...opts });
    const c = this._modelTopLeftForCentre(gp.x, gp.y, DAGEditor._NODE_MIN_H);
    return this._createNodeAt(x !== undefined ? x : c.x, y !== undefined ? y : c.y, { label, ...opts });
  }

  /** Add an edge. Returns true on success. */
  addEdge(fromNodeId, fromPortId, toNodeId, toPortId) {
    return this._tryAddEdge(fromNodeId, fromPortId, toNodeId, toPortId);
  }

  /** Delete a node (and connected edges) by ID. */
  deleteNode(id) { this._selected = { kind: 'node', id }; this._deleteSelected(); }

  /** Delete an edge by ID. */
  deleteEdge(id) { this._selected = { kind: 'edge', id }; this._deleteSelected(); }

  /** Return { nodes: DAGNode[], edges: DAGEdge[] } */
  getGraph() {
    return {
      nodes: [...this._nodes.values()],
      edges: [...this._edges.values()],
    };
  }

  /**
   * Load a graph from a plain object (e.g. from toJSON / fromJSON).
   * Accepts both schema v1 (legacy) and v2.
   */
  loadGraph(data) {
    this._setSelected(null, null);
    this._nodes.clear(); this._edges.clear();
    this._nodeSeq = 0; this._edgeSeq = 0;
    const version = data.version ?? 1;

    (data.nodes || []).forEach(n => {
      let node;
      if (version === 1) {
        // Upgrade v1 node: add default single input/output port
        node = new DAGNode({ ...n, inputs: [{ id: 'in', label: '' }], outputs: [{ id: 'out', label: '' }] });
      } else {
        node = DAGNode.fromJSON(n);
      }
      this._nodes.set(node.id, node);
      const num = parseInt(node.id.replace(/\D/g, ''), 10);
      if (num > this._nodeSeq) this._nodeSeq = num;
    });

    (data.edges || []).forEach(raw => {
      let edge;
      if (version === 1) {
        // Upgrade v1 edge: { id, from, to } → v2
        edge = new DAGEdge({ id: raw.id, fromNodeId: raw.from, fromPortId: 'out', toNodeId: raw.to, toPortId: 'in' });
      } else {
        edge = DAGEdge.fromJSON(raw);
      }
      this._edges.set(edge.id, edge);
      const num = parseInt(edge.id.replace(/\D/g, ''), 10);
      if (num > this._edgeSeq) this._edgeSeq = num;
    });

    this._selected = null;
    this._snapshot(); this._render(); this._fitView();
    this._triggerPinnedLayout();
  }

  /**
   * Export graph as a JSON-serialisable plain object (schema version 2).
   * @returns {{ version:2, nodes:object[], edges:object[] }}
   */
  toJSON() {
    return {
      version: 2,
      nodes: [...this._nodes.values()].map(n => n.toJSON()),
      edges: [...this._edges.values()].map(e => e.toJSON()),
    };
  }

  /**
   * Load graph from a plain object produced by toJSON().
   * @param {object} data
   * @returns {DAGEditor} this
   */
  fromJSON(data) {
    if (!data || typeof data !== 'object') throw new Error('DAGEditor.fromJSON: expected a plain object');
    const v = data.version ?? 1;
    if (v !== 1 && v !== 2) throw new Error(`DAGEditor.fromJSON: unsupported version ${v}`);
    this.loadGraph(data);
    return this;
  }

  /**
   * Serialise graph to a JSON string.
   * @param {number|string} [space]
   * @returns {string}
   */
  exportJSON(space) { return JSON.stringify(this.toJSON(), null, space); }

  /**
   * Load graph from a JSON string produced by exportJSON().
   * @param {string} json
   * @returns {DAGEditor} this
   */
  importJSON(json) {
    let data;
    try { data = JSON.parse(json); }
    catch (e) { throw new Error(`DAGEditor.importJSON: invalid JSON — ${e.message}`); }
    return this.fromJSON(data);
  }

  /* ─────────────────── node and port editing ─────────────────── */

  _portList(node, direction) {
    if (direction === 'input')  return node.inputs;
    if (direction === 'output') return node.outputs;
    throw new Error(`DAGEditor: direction must be 'input' or 'output', got '${direction}'`);
  }

  _uniquePortId(node, direction) {
    const base = direction === 'input' ? 'in' : 'out';
    const used = new Set(this._portList(node, direction).map(p => p.id));
    if (!used.has(base)) return base;
    let n = 2;
    while (used.has(`${base}${n}`)) n++;
    return `${base}${n}`;
  }

  /**
   * Set a node's label. Fires { type:'updated', node }.
   * Repeated edits of the same label share one undo step.
   * @returns {boolean} false if the node does not exist
   */
  setNodeLabel(nodeId, label) {
    const node = this._nodes.get(nodeId);
    if (!node) return false;
    label = String(label);
    if (node.label === label) return true;
    node.label = label;
    this._snapshot(`label:${nodeId}`);
    this._render();
    this._onChange({ type: 'updated', node });
    return true;
  }

  /**
   * Add a port to a node. Fires { type:'updated', node }.
   * @param {string} nodeId
   * @param {'input'|'output'} direction
   * @param {{id?:string, label?:string}} [opts] id defaults to a unique 'in'/'out' name
   * @returns {{id:string,label:string}|null} the port, or null if the node is unknown
   *          or the requested id is already used on that side
   */
  addPort(nodeId, direction, opts = {}) {
    const node = this._nodes.get(nodeId);
    if (!node) return null;
    const list = this._portList(node, direction);
    const id   = opts.id ?? this._uniquePortId(node, direction);
    if (list.some(p => p.id === id)) return null;
    const port = { id, label: String(opts.label ?? '') };
    list.push(port);
    this._snapshot();
    this._render();
    this._onChange({ type: 'updated', node });
    return port;
  }

  /**
   * Remove a port, along with every edge attached to it.
   * Fires 'edge-deleted' for each removed edge, then { type:'updated', node }.
   * @returns {boolean} false if the node or port does not exist
   */
  removePort(nodeId, direction, portId) {
    const node = this._nodes.get(nodeId);
    if (!node) return false;
    const list = this._portList(node, direction);
    const idx  = list.findIndex(p => p.id === portId);
    if (idx < 0) return false;

    const removed = [];
    for (const [eid, e] of this._edges) {
      const attached = direction === 'output'
        ? e.fromNodeId === nodeId && e.fromPortId === portId
        : e.toNodeId   === nodeId && e.toPortId   === portId;
      if (attached) { removed.push(e); this._edges.delete(eid); }
    }
    list.splice(idx, 1);

    if (this._selected?.kind === 'edge' && removed.some(e => e.id === this._selected.id)) {
      this._setSelected(null, null);
    }
    this._snapshot();
    this._render();
    for (const e of removed) this._onChange({ type: 'edge-deleted', edge: e });
    this._onChange({ type: 'updated', node });
    if (removed.length) this._triggerPinnedLayout();
    return true;
  }

  /**
   * Set a port's label. Fires { type:'updated', node }.
   * Repeated edits of the same label share one undo step.
   * @returns {boolean} false if the node or port does not exist
   */
  setPortLabel(nodeId, direction, portId, label) {
    const node = this._nodes.get(nodeId);
    if (!node) return false;
    const port = this._portList(node, direction).find(p => p.id === portId);
    if (!port) return false;
    label = String(label);
    if (port.label === label) return true;
    port.label = label;
    this._snapshot(`plabel:${nodeId}:${direction}:${portId}`);
    this._render();
    this._onChange({ type: 'updated', node });
    return true;
  }

  /** Remove the editor and clean up. */
  destroy() {
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    if (this._windowResize)   { window.removeEventListener('resize', this._windowResize); this._windowResize = null; }
    this._container.innerHTML = '';
  }
}
