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
    this._lineCache   = new Map();   // node id → { label, maxW, lines }  (wrapped label text)

    this._layoutActive    = false;
    this._layoutPinned    = false;   // double-click mode: re-layout on every graph change
    this._layoutRaf       = null;
    this._layoutVel       = new Map();
    this._layoutShadow    = null;
    this._layoutStartTime = 0;

    this._buildDOM();
    this._attachEvents();
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
  static _LABEL_W_COMPACT  = 98;    // label wrap width, compact nodes (leaves room for 1-char port labels)
  static _LABEL_W_EXPANDED = 120;   // label wrap width, expanded nodes (label sits in its own header)

  /* A port label is "short" if it has 0 or 1 characters (a surrogate pair counts as one). */
  static _isShortLabel(s) {
    return s.length <= 1 || (s.length === 2 && s.codePointAt(0) > 0xFFFF);
  }

  /* Compact layout: no header/divider; label centred, ports stacked at mid-height.
   * A node is compact if it has at most one port on each side, OR if every port
   * on both sides has a label of length 0 or 1 (so many short-labelled ports still fit). */
  _isCompact(node) {
    if (node.inputs.length <= 1 && node.outputs.length <= 1) return true;
    return node.inputs.every(p => DAGEditor._isShortLabel(p.label)) &&
           node.outputs.every(p => DAGEditor._isShortLabel(p.label));
  }

  /* ── node label wrapping ── */

  /* Rendered width of a string in the node-label font; estimated when it cannot be measured. */
  _textWidth(str) {
    const el = this._measureEl;
    if (el && typeof el.getComputedTextLength === 'function') {
      el.textContent = str;
      const w = el.getComputedTextLength();
      if (w > 0) return w;
    }
    return str.length * 7.2;
  }

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

  /* Wrapped lines of a node's label (cached until the label or layout class changes). */
  _labelLines(node) {
    const maxW = this._isCompact(node) ? DAGEditor._LABEL_W_COMPACT : DAGEditor._LABEL_W_EXPANDED;
    let c = this._lineCache.get(node.id);
    if (!c || c.label !== node.label || c.maxW !== maxW) {
      c = { label: node.label, maxW, lines: this._wrapLabel(node.label, maxW) };
      this._lineCache.set(node.id, c);
    }
    return c.lines;
  }

  /* Expanded nodes: height of the header (label block) above the ports. */
  _headerHeight(node) {
    return DAGEditor._PORT_TOP + (this._labelLines(node).length - 1) * DAGEditor._LINE_H;
  }

  /* Dynamic node height: grows to fit the wrapped label and the ports. */
  _nodeHeight(node) {
    const PP    = DAGEditor._PORT_PITCH;
    const ports = Math.max(node.inputs.length, node.outputs.length);
    if (this._isCompact(node)) {
      const labelH = this._labelLines(node).length * DAGEditor._LINE_H + 30;
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

  /* Position of a specific output port in graph coords */
  _outputPortPos(node, portId) {
    const idx = node.outputs.findIndex(p => p.id === portId);
    if (idx < 0) return null;
    return { x: node.x + DAGEditor._NODE_W, y: node.y + this._portLocalY(node, 'output', idx) };
  }

  /* Position of a specific input port in graph coords */
  _inputPortPos(node, portId) {
    const idx = node.inputs.findIndex(p => p.id === portId);
    if (idx < 0) return null;
    return { x: node.x, y: node.y + this._portLocalY(node, 'input', idx) };
  }

  /* First output / input port positions */
  _firstOutputPos(node) {
    if (!node.outputs.length) return { x: node.x + DAGEditor._NODE_W, y: node.y + this._nodeHeight(node) / 2 };
    return this._outputPortPos(node, node.outputs[0].id);
  }

  _firstInputPos(node) {
    if (!node.inputs.length) return { x: node.x, y: node.y + this._nodeHeight(node) / 2 };
    return this._inputPortPos(node, node.inputs[0].id);
  }

  _nodeHitTest(node, gx, gy) {
    const h = this._nodeHeight(node);
    return gx >= node.x && gx <= node.x + DAGEditor._NODE_W && gy >= node.y && gy <= node.y + h;
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

  /* ─────────────────── coordinate helpers ─────────────────── */
  _svgRect() { return this._svg.getBoundingClientRect(); }

  _clientToGraph(cx, cy) {
    const r = this._svgRect();
    return { x: (cx - r.left - this._viewX) / this._scale,
             y: (cy - r.top  - this._viewY) / this._scale };
  }

  _graphToSVG(gx, gy) {
    return { x: gx * this._scale + this._viewX, y: gy * this._scale + this._viewY };
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
      const PR = DAGEditor._PORT_R;
      // Output ports
      for (const port of node.outputs) {
        const pos = this._outputPortPos(node, port.id);
        if (this._portHitTest(pos, gp.x, gp.y)) {
          const sx = pos.x + PR, sy = pos.y;  // start at port surface
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
          const ex = pos.x - PR, ey = pos.y;  // end at port surface
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
    for (const edge of this._edges.values()) {
      if (this._edgeHitTest(edge, gp.x, gp.y)) {
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
    this._createNodeAt(gp.x - DAGEditor._NODE_W / 2, gp.y - DAGEditor._NODE_MIN_H / 2);
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
      node.x = this._dragging.origX + dx;
      node.y = this._dragging.origY + dy;
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

      const W = DAGEditor._NODE_W, H = DAGEditor._NODE_MIN_H;

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
          const nn = this._createNodeAt(gp.x - W / 2, gp.y - H / 2);
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
          const nn = this._createNodeAt(gp.x - W / 2, gp.y - H / 2);
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
    for (const edge of this._edges.values()) {
      if (!this._edgeHitTest(edge, gp.x, gp.y)) continue;

      const fromNode = this._nodes.get(edge.fromNodeId);
      const toNode   = this._nodes.get(edge.toNodeId);
      if (!fromNode || !toNode) continue;

      const W = DAGEditor._NODE_W, H = DAGEditor._NODE_MIN_H;

      // Create the new node centred on the click, with matching port types
      const newNode = this._createNodeAt(gp.x - W / 2, gp.y - H / 2, {
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
  _edgeHitTest(edge, gx, gy, tol = 7) {
    const p1 = this._edgeP1(edge), p2 = this._edgeP2(edge);
    if (!p1 || !p2) return false;
    for (let t = 0; t <= 1; t += 0.05) {
      const b = this._bezierAt(p1, p2, t);
      if (Math.hypot(gx - b.x, gy - b.y) < tol) return true;
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
  _edgeGeom(p1, p2) {
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

  _edgePath(edge) {
    const p1 = this._edgeP1(edge), p2 = this._edgeP2(edge);
    if (!p1 || !p2) return '';
    const { sx, sy, cx1, cy1, cx2, cy2, ex, ey } = this._edgeGeom(p1, p2);
    return `M${sx},${sy} C${cx1},${cy1} ${cx2},${cy2} ${ex},${ey}`;
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

  _createNodeAtCenter() {
    const r  = this._svgRect();
    const gp = this._clientToGraph(r.left + r.width / 2, r.top + r.height / 2);
    const off = this._nodes.size * 24 % 160;
    return this._createNodeAt(gp.x - DAGEditor._NODE_W / 2 + off, gp.y - DAGEditor._NODE_MIN_H / 2 + off);
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
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + DAGEditor._NODE_W);
      maxY = Math.max(maxY, n.y + this._nodeHeight(n));
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
    for (const edge of this._edges.values()) {
      const sel = this._selected?.kind === 'edge' && this._selected.id === edge.id;
      let el = this._gEdges.querySelector(`[data-id="${edge.id}"]`);
      if (!el) {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        el.dataset.id = edge.id;
        el.setAttribute('fill', 'none');
        this._gEdges.appendChild(el);
      }
      el.setAttribute('d', this._edgePath(edge));
      el.setAttribute('class', sel ? 'dag-edge dag-edge--selected' : 'dag-edge');
      el.setAttribute('marker-end', sel ? 'url(#dag-arrow-sel)' : 'url(#dag-arrow)');
    }
  }

  _renderNodes() {
    const existing = new Set(this._nodes.keys());
    for (const el of [...this._gNodes.children]) {
      if (!existing.has(el.dataset.id)) el.remove();
    }

    const W  = DAGEditor._NODE_W;
    const RX = DAGEditor._NODE_RX;
    const PR = DAGEditor._PORT_R;
    const LH = DAGEditor._LINE_H;
    const SVGNS = 'http://www.w3.org/2000/svg';

    for (const id of [...this._lineCache.keys()]) {
      if (!this._nodes.has(id)) this._lineCache.delete(id);
    }

    for (const node of this._nodes.values()) {
      const H       = this._nodeHeight(node);
      const compact = this._isCompact(node);
      const sel     = this._selected?.kind === 'node' && this._selected.id === node.id;

      let g = this._gNodes.querySelector(`[data-id="${node.id}"]`);
      if (!g) {
        g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.dataset.id = node.id;
        this._gNodes.appendChild(g);
      }

      g.setAttribute('transform', `translate(${node.x},${node.y})`);
      g.setAttribute('class', `dag-node${sel ? ' dag-node--selected' : ''}${compact ? ' dag-node--compact' : ''}`);

      // background rect
      let rect = g.querySelector('rect.dag-node-bg');
      if (!rect) {
        rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('class', 'dag-node-bg');
        rect.setAttribute('rx', RX); rect.setAttribute('ry', RX);
        g.prepend(rect);
      }
      rect.setAttribute('width', W); rect.setAttribute('height', H);

      // label — wrapped onto several lines; the block is centred vertically in compact
      // mode and starts at the top (above the divider) in expanded mode
      let labelEl = g.querySelector('text.dag-node-label');
      if (!labelEl) {
        labelEl = document.createElementNS(SVGNS, 'text');
        labelEl.setAttribute('class', 'dag-node-label');
        labelEl.setAttribute('dominant-baseline', 'middle');
        labelEl.setAttribute('text-anchor', 'middle');
        g.appendChild(labelEl);
      }
      const lines  = this._labelLines(node);
      const firstY = compact ? H / 2 - (lines.length - 1) * LH / 2 : 18;
      const lkey   = lines.join('\n');
      if (labelEl.dataset.lines !== lkey) {
        labelEl.replaceChildren();
        for (const line of lines) {
          const t = document.createElementNS(SVGNS, 'tspan');
          t.setAttribute('x', W / 2);
          t.setAttribute('dominant-baseline', 'middle');
          t.textContent = line;
          labelEl.appendChild(t);
        }
        labelEl.dataset.lines = lkey;
      }
      [...labelEl.children].forEach((t, i) => t.setAttribute('y', firstY + i * LH));

      // divider — only in expanded mode
      let divider = g.querySelector('line.dag-node-divider');
      if (!compact) {
        if (!divider) {
          divider = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          divider.setAttribute('class', 'dag-node-divider');
          g.appendChild(divider);
        }
        const dy = this._headerHeight(node) - 6;
        divider.setAttribute('x1', 0); divider.setAttribute('y1', dy);
        divider.setAttribute('x2', W); divider.setAttribute('y2', dy);
        divider.style.display = '';
      } else if (divider) {
        divider.style.display = 'none';
      }

      // ports
      const keepPorts = new Set();

      const addPort = (port, dir, cx, cy) => {
        const pid = `${port.id}:${dir}`;
        keepPorts.add(pid);
        let circle = g.querySelector(`circle[data-port-uid="${pid}"]`);
        if (!circle) {
          circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
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
            lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            lbl.dataset.portUid = lid;
            lbl.setAttribute('class', `dag-port-label dag-port-label-${dir}`);
            lbl.setAttribute('dominant-baseline', 'middle');
            g.appendChild(lbl);
          }
          // Inside the node body: input labels right of the port dot, output labels left of it
          lbl.setAttribute('text-anchor', dir === 'in' ? 'start' : 'end');
          lbl.setAttribute('x', dir === 'in' ? PR + 4 : W - PR - 4);
          lbl.setAttribute('y', cy);
          lbl.textContent = port.label || '';
          lbl.style.display = '';
        } else if (lbl) {
          lbl.style.display = 'none';
        }
      };

      node.inputs.forEach((port, i) => {
        addPort(port, 'in', 0, this._portLocalY(node, 'input', i));
      });

      node.outputs.forEach((port, i) => {
        addPort(port, 'out', W, this._portLocalY(node, 'output', i));
      });

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
      // Already running — restart the timer so it gets full time from now
      this._layoutStartTime = performance.now();
    } else {
      this.autoLayout(true);
    }
  }

  autoLayout(active) {
    this._layoutActive = active;
    this._updateLayoutBtn();
    if (active) {
      for (const id of this._nodes.keys()) {
        this._layoutVel.set(id, { vx: 0, vy: 0 });
      }
      this._layoutStartTime = performance.now();
      this._layoutTick();
    } else {
      if (this._layoutRaf) { cancelAnimationFrame(this._layoutRaf); this._layoutRaf = null; }
      this._snapshot();
    }
  }

  _layoutTick() {
    if (!this._layoutActive) return;
    const ids   = [...this._nodes.keys()];
    const edges = [...this._edges.values()];
    const W     = DAGEditor._NODE_W;
    const PAD_X = 60, PAD_Y = 20, MAX_STEP = 18, DT = 1;

    const DEADLINE = 1500;
    const elapsed  = performance.now() - this._layoutStartTime;
    const t        = Math.min(1, elapsed / 1000);
    const DAMPING  = 0.75 + t * 0.22;
    if (elapsed >= DEADLINE) { this._layoutActive = false; this._updateLayoutBtn(); this._snapshot(); return; }

    const stratum      = this._computeStrata();
    const stratTargetX = s => s * (W + PAD_X);
    const force        = new Map(ids.map(id => [id, { fx: 0, fy: 0 }]));

    // Stratum X anchor
    for (const id of ids) {
      const node = this._nodes.get(id);
      const dx   = stratTargetX(stratum.get(id) ?? 0) - (node.x + W / 2);
      force.get(id).fx += dx * 0.25;
    }

    // Even-spacing + barycentric crossing reduction
    const neighbours = new Map(ids.map(id => [id, []]));
    for (const e of edges) {
      if (neighbours.has(e.fromNodeId) && neighbours.has(e.toNodeId)) {
        neighbours.get(e.fromNodeId).push(e.toNodeId);
        neighbours.get(e.toNodeId).push(e.fromNodeId);
      }
    }
    const byStratum = new Map();
    for (const id of ids) {
      const s = stratum.get(id) ?? 0;
      if (!byStratum.has(s)) byStratum.set(s, []);
      byStratum.get(s).push(id);
    }
    const SLOT_STR = 0.20;
    for (const [, members] of byStratum) {
      if (members.length < 2) continue;
      // Slot spacing allows for the tallest node in the stratum (wrapped labels, many ports)
      const SLOT_GAP = Math.max(...members.map(id => this._nodeHeight(this._nodes.get(id)))) + PAD_Y * 2.5;
      const weight = id => {
        const node  = this._nodes.get(id);
        const cross = (neighbours.get(id) ?? []).filter(nid => (stratum.get(nid) ?? 0) !== (stratum.get(id) ?? 0));
        if (!cross.length) return node.y;
        return cross.reduce((a, nid) => a + this._nodes.get(nid).y, 0) / cross.length;
      };
      members.sort((a, b) => weight(a) - weight(b));
      const centY  = members.reduce((a, id) => a + this._nodes.get(id).y, 0) / members.length;
      const startY = centY - (members.length - 1) * SLOT_GAP / 2;
      members.forEach((id, k) => {
        force.get(id).fy += (startY + k * SLOT_GAP - this._nodes.get(id).y) * SLOT_STR;
      });
    }

    // Cross-stratum repulsion
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const ai = ids[i], bi = ids[j];
        if ((stratum.get(ai) ?? 0) === (stratum.get(bi) ?? 0)) continue;
        const a = this._nodes.get(ai), b = this._nodes.get(bi);
        const dx = (b.x + W / 2) - (a.x + W / 2), dy = b.y - a.y;
        const overlapX = (W + PAD_X * 0.5) - Math.abs(dx);
        const overlapY = (DAGEditor._NODE_MIN_H + PAD_Y) - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          const fx = (dx < 0 ? -1 : 1) * overlapX * 4;
          force.get(ai).fx -= fx; force.get(bi).fx += fx; continue;
        }
        const dist = Math.sqrt(dx*dx + dy*dy) || 0.01;
        if (dist < W * 2) {
          const mag = 6000 / (dist * dist);
          force.get(ai).fx -= (dx/dist)*mag; force.get(ai).fy -= (dy/dist)*mag;
          force.get(bi).fx += (dx/dist)*mag; force.get(bi).fy += (dy/dist)*mag;
        }
      }
    }

    // Edge Y centering
    for (const e of edges) {
      const a = this._nodes.get(e.fromNodeId), b = this._nodes.get(e.toNodeId);
      if (!a || !b) continue;
      const dy = b.y - a.y, fy = dy * 0.03;
      force.get(e.fromNodeId).fy += fy; force.get(e.toNodeId).fy -= fy;
    }

    // Edge-node repulsion: push nodes away from edges that pass through them.
    // Sample the bezier at N points, find the closest sample to each non-endpoint
    // node's centre, and apply a repulsion force perpendicular to the curve.
    const EDGE_NODE_STR = 80;   // repulsion strength
    const EDGE_NODE_R   = DAGEditor._NODE_MIN_H * 1.2; // influence radius
    const SAMPLES       = 12;
    for (const e of edges) {
      const na = this._nodes.get(e.fromNodeId), nb = this._nodes.get(e.toNodeId);
      if (!na || !nb) continue;
      const p1 = this._firstOutputPos(na), p2 = this._firstInputPos(nb);
      if (!p1 || !p2) continue;
      const { sx, sy, cx1, cy1, cx2, cy2, ex, ey } = this._edgeGeom(p1, p2);

      // Pre-sample the curve
      const pts = [];
      for (let s = 0; s <= SAMPLES; s++) {
        const t = s / SAMPLES, mt = 1 - t;
        pts.push({
          x: mt*mt*mt*sx + 3*mt*mt*t*cx1 + 3*mt*t*t*cx2 + t*t*t*ex,
          y: mt*mt*mt*sy + 3*mt*mt*t*cy1 + 3*mt*t*t*cy2 + t*t*t*ey,
        });
      }

      for (const id of ids) {
        if (id === e.fromNodeId || id === e.toNodeId) continue;
        const node = this._nodes.get(id);
        const cx   = node.x + W / 2;
        const cy   = node.y + this._nodeHeight(node) / 2;

        // Find closest point on the sampled polyline
        let minDist = Infinity, nearX = 0, nearY = 0;
        for (let s = 0; s < pts.length - 1; s++) {
          const ax = pts[s].x,   ay = pts[s].y;
          const bx = pts[s+1].x, by = pts[s+1].y;
          const abx = bx - ax, aby = by - ay;
          const len2 = abx*abx + aby*aby || 1;
          const tt   = Math.max(0, Math.min(1, ((cx-ax)*abx + (cy-ay)*aby) / len2));
          const px   = ax + tt*abx, py = ay + tt*aby;
          const d    = Math.hypot(cx - px, cy - py);
          if (d < minDist) { minDist = d; nearX = px; nearY = py; }
        }

        if (minDist < EDGE_NODE_R && minDist > 0.01) {
          const mag = EDGE_NODE_STR * (1 - minDist / EDGE_NODE_R);
          const dx  = (cx - nearX) / minDist;
          const dy  = (cy - nearY) / minDist;
          // Push the node away; nudge endpoints in opposite direction (lighter)
          force.get(id).fx             += dx * mag;
          force.get(id).fy             += dy * mag;
          force.get(e.fromNodeId).fx   -= dx * mag * 0.15;
          force.get(e.fromNodeId).fy   -= dy * mag * 0.15;
          force.get(e.toNodeId).fx     -= dx * mag * 0.15;
          force.get(e.toNodeId).fy     -= dy * mag * 0.15;
        }
      }
    }

    // Integrate directly into node positions
    let totalMovement = 0;
    for (const id of ids) {
      const node = this._nodes.get(id);
      const vel  = this._layoutVel.get(id) || { vx: 0, vy: 0 };
      const f    = force.get(id);
      vel.vx = (vel.vx + f.fx * DT) * DAMPING;
      vel.vy = (vel.vy + f.fy * DT) * DAMPING;
      const speed = Math.sqrt(vel.vx*vel.vx + vel.vy*vel.vy);
      if (speed > MAX_STEP) { vel.vx *= MAX_STEP/speed; vel.vy *= MAX_STEP/speed; }
      node.x += vel.vx * DT; node.y += vel.vy * DT;
      this._layoutVel.set(id, vel);
      totalMovement += speed;
    }

    this._render();
    this._fitView();

    if (totalMovement < 0.5) { this._layoutActive = false; this._updateLayoutBtn(); this._snapshot(); return; }
    this._layoutRaf = requestAnimationFrame(() => this._layoutTick());
  }

  /* ─────────────────── public API ─────────────────── */

  /**
   * Add a node programmatically.
   * @param {string} label
   * @param {number} [x]
   * @param {number} [y]
   * @param {object} [opts] - { inputs, outputs } port arrays
   * @returns {DAGNode}
   */
  addNode(label, x, y, opts = {}) {
    const r  = this._svgRect();
    const gp = this._clientToGraph(r.left + r.width / 2, r.top + r.height / 2);
    return this._createNodeAt(
      x !== undefined ? x : gp.x - DAGEditor._NODE_W / 2,
      y !== undefined ? y : gp.y - DAGEditor._NODE_MIN_H / 2,
      { label, ...opts }
    );
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
  destroy() { this._container.innerHTML = ''; }
}
