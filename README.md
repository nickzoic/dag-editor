# DAGEditor

A standalone, zero-dependency interactive editor for directed acyclic graphs. Drop it into any page — no build step, no npm, no frameworks.

## Files

| File | Purpose |
|------|---------|
| `dag-editor.js` | All logic — `DAGNode`, `DAGEdge`, `DAGEditor` classes |
| `dag-editor.css` | All styles and design tokens |
| `dag-editor-demo.html` | Working demo (requires the two files above in the same directory) |

## Quick Start

```html
<link rel="stylesheet" href="dag-editor.css">

<div id="my-graph" style="height: 480px;"></div>

<script src="dag-editor.js"></script>
<script>
  const editor = new DAGEditor(
    document.getElementById('my-graph'),
    (event) => {
      console.log(event.type, event.node ?? event.edge);
    }
  );
</script>
```

Open `dag-editor-demo.html` in a browser (with `dag-editor.js` and `dag-editor.css` in the same folder) to see a fully working example with a sample pipeline graph, event log, and JSON import/export.

---

## Nodes and Ports

Each node has zero or more named **input ports** (left side) and zero or more named **output ports** (right side). Ports have an `id` and an optional `label`.

A node with ≤ 1 input and ≤ 1 output renders in a compact single-row layout. Nodes with more ports expand vertically and show port labels inside the body.

```js
// Create a node with custom ports
editor.addNode('Transform', 100, 80, {
  inputs:  [{ id: 'raw',  label: 'raw data' }],
  outputs: [{ id: 'out',  label: 'result'   }],
});

// Default: one input port ("in") and one output port ("out")
editor.addNode('Filter');
```

---

## Mouse Interactions

| Gesture | Action |
|---------|--------|
| Click empty canvas | Create a new node |
| Click node | Select it |
| Click edge | Select it |
| Drag node body | Move node |
| Drag output port → canvas | Draw edge; create destination node on drop |
| Drag output port → input port or node | Connect edge |
| Drag input port (reverse) | Same, in reverse direction |
| Double-click node | Rename inline |
| Double-click edge | Insert a new node on the edge |
| Scroll | Zoom |
| Alt + drag | Pan |

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Delete` / `Backspace` | Delete selected node or edge |
| `Escape` | Deselect |
| `N` | New node at canvas centre |
| `Tab` / `Shift+Tab` | Cycle node selection |
| `Enter` | Rename selected node |
| `L` | One-shot auto-layout |
| `Shift+L` | Toggle pinned auto-layout |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |

---

## Auto-Layout

Click **⟳ Layout** (or press `L`) for a one-shot animated layout that sorts nodes left-to-right by their depth in the graph, spaces them vertically to minimise edge crossings, and fits the result to the window.

**Double-click** the Layout button (or press `Shift+L`) to **pin** auto-layout: the graph will re-layout automatically whenever edges are added or removed. The button pulses teal while pinned.

---

## API

### Constructor

```js
const editor = new DAGEditor(containerEl, onChange);
```

- `containerEl` — any `HTMLElement`. The editor fills it.
- `onChange(event)` — called on every graph change (see Events below).

### Methods

```js
// Graph manipulation
editor.addNode(label, x?, y?, { inputs?, outputs? })  // → DAGNode
editor.addEdge(fromNodeId, fromPortId, toNodeId, toPortId)  // → boolean
editor.deleteNode(id)
editor.deleteEdge(id)

// Query
editor.getGraph()  // → { nodes: DAGNode[], edges: DAGEdge[] }

// Import / export
editor.toJSON()          // → plain object (schema v2)
editor.fromJSON(data)    // load from plain object → this
editor.exportJSON(indent?)  // → JSON string
editor.importJSON(json)     // parse and load → this
editor.loadGraph(data)   // load plain object (v1 or v2), fit view

// View
editor.autoLayout(active)  // programmatic layout control
editor.undo()
editor.redo()
editor.destroy()           // remove all DOM
```

### Events

```js
{ type: 'created',      node: DAGNode }  // node created
{ type: 'selected',     node: DAGNode }  // node selected or renamed
{ type: 'deleted',      node: DAGNode }  // node deleted
{ type: 'edge-created', edge: DAGEdge }  // edge created
{ type: 'edge-deleted', edge: DAGEdge }  // edge deleted
```

`DAGNode` properties: `id`, `label`, `x`, `y`, `inputs[]`, `outputs[]`  
`DAGEdge` properties: `id`, `fromNodeId`, `fromPortId`, `toNodeId`, `toPortId`

---

## JSON Schema

```json
{
  "version": 2,
  "nodes": [
    {
      "id": "n1",
      "label": "Source",
      "x": 40, "y": 100,
      "inputs":  [],
      "outputs": [{ "id": "data", "label": "data" }]
    }
  ],
  "edges": [
    {
      "id": "e1",
      "fromNodeId": "n1", "fromPortId": "data",
      "toNodeId":   "n2", "toPortId":   "raw"
    }
  ]
}
```

Version 1 graphs (single implicit port per node, `from`/`to` edge fields) are automatically upgraded on load.

---

## Theming

All colours are CSS custom properties on `:root` in `dag-editor.css`:

```css
:root {
  --dag-bg:          #0f1117;  /* canvas background    */
  --dag-node-fill:   #1e2538;  /* node background      */
  --dag-node-stroke: #3a4466;  /* node border          */
  --dag-node-sel:    #4a7cff;  /* selection blue       */
  --dag-node-text:   #c8d0f0;  /* label text           */
  --dag-edge:        #3a4466;  /* edge stroke          */
  --dag-accent:      #4a7cff;  /* selected edge        */
  --dag-draft:       #ff9f4a;  /* draft edge (orange)  */
  --dag-port:        #4a7cff;  /* port highlight       */
  /* … see dag-editor.css for the full list */
}
```

---

## Requirements

The full behavioural requirements that this component was designed to satisfy are in [`dag-editor-requirements.md`](dag-editor-requirements.md).
