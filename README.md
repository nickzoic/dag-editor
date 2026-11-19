# DAGEditor

A standalone, zero-dependency interactive editor for directed acyclic graphs. Drop it into any page — no build step, no npm, no frameworks.

![The DAGEditor demo: a 12-node sample graph laid out automatically, with the Enrich node selected and its label and ports shown in the node editor below](screenshot.png)

* [Live DAGEditor demo page](https://nickzoic.github.io/dag-editor/dag-editor-demo.html)
* [Github Repo](https://github.com/nickzoic/dag-editor/)

[![Tests](https://github.com/nickzoic/dag-editor/actions/workflows/test.yml/badge.svg)](https://github.com/nickzoic/dag-editor/actions/workflows/test.yml)

## Files

| File | Purpose |
|------|---------|
| `dag-editor.js` | All logic — `DAGNode`, `DAGEdge`, `DAGEditor` classes |
| `dag-editor.css` | All styles and design tokens |
| `dag-editor-demo.html` | Working demo (requires the two files above in the same directory) |
| `test/`, `package.json` | The unit and browser tests, and the (development-only) tools they use — see [Running the tests](#running-the-tests) |
| `screenshot.png` | The screenshot at the top of this page |

## Quick Start

```html
<link rel="stylesheet" href="dag-editor.css">

<div id="my-graph" style="height: 100%;"></div>

<script src="dag-editor.js"></script>
<script>
  // Subclass to react to what happens (see Hooks below)
  class MyEditor extends DAGEditor {
    onMoveNode(node) { console.log('moved', node.id, node.x, node.y); }
  }
  const editor = new MyEditor(document.getElementById('my-graph'));
</script>
```

Open `dag-editor-demo.html` in a browser (with `dag-editor.js` and `dag-editor.css` in the same folder) to see a fully working example. It opens with a 12-node sample graph — chosen to show nodes with no, one and several inputs and outputs, compact and expanded nodes, and labelled and unlabelled ports — which is laid out automatically once it has loaded. The graph editor fills the page height, with a **node editor pane** below it (edit the selected node's label and add, remove and label its ports), plus an event log and JSON import/export. The toolbar and hint bar above and below the graph belong to the demo page, not the editor: the editor is just the canvas, and reports what happens through hooks.

---

## Nodes and Ports

Each node has zero or more named **input ports** (left side) and zero or more named **output ports** (right side). Ports have an `id` and an optional `label`.

A node renders in a **compact** layout — no header, label centred, ports stacked down the sides — as long as none of its port labels is longer than one user-perceived character. Characters are counted with `Intl.Segmenter`, so `x̅` (an `x` plus a combining overline), an accented letter written with a combining accent, a flag or a ZWJ emoji sequence each count as one. Any number of unlabelled or one-character-labelled ports stays compact. If any port label is longer, the node **expands**: the label gets its own header above a divider, and each port shows its full label inside the body. (The node's own label is not counted; it wraps instead.)

Long node labels wrap onto several lines (words wider than a line are broken), and the node grows taller to fit.

```js
// Create a node with custom ports
editor.addNode('Transform', 100, 80, {
  inputs:  [{ id: 'raw',  label: 'raw data' }],
  outputs: [{ id: 'out',  label: 'result'   }],
});

// Default: one input port ("in") and one output port ("out")
editor.addNode('Filter');
```

The canvas has no built-in label editor — the host page supplies the UI and drives these methods (the demo's node editor pane is a working example):

```js
editor.setNodeLabel('n3', 'Validate input');
const port = editor.addPort('n3', 'output', { label: 'warnings' });  // id auto-generated: "out", "out2", …
editor.setPortLabel('n3', 'output', port.id, 'warn');
editor.removePort('n3', 'output', port.id);   // also removes every edge attached to that port
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
| `L` | One-shot auto-layout |
| `Shift+L` | Toggle pinned auto-layout |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |

---

## Orientation: landscape and portrait

If the container is **taller than it is wide**, the graph is shown *flipped*: the X and Y axes are swapped, so each node has its inputs on its top edge and its outputs on its bottom edge, and the strata run from top to bottom. Each node keeps its position relative to the others, so a node near the top of a wide pane ends up near the left of a tall one. Text always stays upright: each port label sits just inside the edge, under (or over) its port. The ports on each edge are spread evenly across the node — one in the middle, two at thirds, three at quarters, and so on, whatever their labels — and a node is made wider if its labels need the room.

- Whenever the container is resized, the graph is re-fitted to the new size and the orientation is chosen again (a `ResizeObserver` watches the container).
- Flipping affects only how the graph is drawn. `node.x` and `node.y`, and so `toJSON()`, `exportJSON()` and `getGraph()`, are **always in the unflipped, left-to-right orientation**; `addNode(label, x, y)` and `fromJSON()` take positions in that orientation too.
- `editor.flipped` tells you which orientation is showing.
- Auto-layout leaves room for both orientations, so a graph laid out in one looks right in the other.

## Auto-Layout

Click **⟳ Layout** (or press `L`) for a one-shot animated layout. Nodes are arranged in columns left to right by their depth in the graph, ordered within each column to reduce edge crossings, and positioned so connected ports line up. Nodes never overlap. An edge that runs across several columns is drawn straight from port to port whenever nothing is in its way. If something is, it is given a lane through each column it crosses and drawn through those lanes, so it does not cut across the nodes in between; each edge rises or falls only in the gaps between columns. The nodes glide into place (about half a second) while the view stays fitted to the window. The result is deterministic: the same graph and arrangement always lay out the same way.

A long edge stays straight while its straight line is clear of the other nodes, and uses its lanes otherwise. So moving a node only affects the edges whose drawn curves it now lies across: a small move changes nothing, and a node moved onto an edge's straight line makes that edge use its lanes. If the lanes are blocked too, the edge is drawn as a single curve until you lay out again. The routes are not saved in the exported JSON.

**Double-click** the Layout button (or press `Shift+L`) to **pin** auto-layout: the graph will re-layout automatically whenever edges are added or removed. The demo page's Layout button shows whether a run is in progress and whether it is pinned.

---

## API

### Constructor

```js
const editor = new DAGEditor(containerEl);
```

- `containerEl` — any `HTMLElement`. The editor fills it. The editor draws only the canvas: no toolbar, no hint bar. Those belong to the host page, which calls the methods below and overrides the hooks.

### Hooks

The editor reports what happens by calling methods on itself. They do nothing by default. A host page overrides the ones it needs, either by subclassing or on an instance:

```js
class MyEditor extends DAGEditor {
  onAddNode(node)      { save(); }
  onMoveNode(node)     { console.log(node.label, 'moved to', node.x, node.y); }
}

// or, on one instance:
editor.onNotice = message => showToast(message);
```

| Hook | Called when |
|------|-------------|
| `onAddNode(node)` | a node is added |
| `onDeleteNode(node)` | a node is deleted (its edges are reported first) |
| `onSelectNode(node)` / `onDeselectNode(node)` | a node becomes selected / stops being selected |
| `onSelectEdge(edge)` / `onDeselectEdge(edge)` | an edge becomes selected / stops being selected |
| `onUpdateNode(node)` | a node's label, or one of its ports, changes |
| `onAddEdge(edge)` | an edge is added |
| `onDeleteEdge(edge)` | an edge is deleted (directly, with its node or port, or spliced out) |
| `onMoveNode(node)` | the user drags a node and lets go, once per drag, and only if it moved (automatic layout does not call it) |
| `onNotice(message)` | there is something to tell the user, such as why an edge was refused |
| `onLayoutChange(active)` | an auto-layout run starts (`true`) or stops (`false`) |
| `onPinChange(pinned)` | pinned auto-layout is switched on or off |

Each hook is called after the change, so the editor can be queried from inside it. Selecting a node, for example, makes `getGraph()` and `selected` already reflect it. `DAGNode` has `id`, `label`, `x`, `y`, `inputs[]` and `outputs[]`; `DAGEdge` has `id`, `fromNodeId`, `fromPortId`, `toNodeId` and `toPortId`. Positions in the hooks and in `getGraph()` are in the editor's own units (see JSON Schema for exported positions).

Removing a port that has edges reports `onDeleteEdge` for each, then `onUpdateNode`.

### Methods

```js
// Graph manipulation
editor.addNode(label, x?, y?, { inputs?, outputs? })  // → DAGNode (no position: the middle of the view)
editor.addNodeAtCentre()                              // → DAGNode, offset from the last one
editor.addEdge(fromNodeId, fromPortId, toNodeId, toPortId)  // → boolean
editor.deleteNode(id)
editor.deleteEdge(id)
editor.deleteSelected()                               // the selected node or edge

// Node and port editing  (direction is 'input' or 'output')
editor.setNodeLabel(nodeId, label)                    // → boolean
editor.addPort(nodeId, direction, { id?, label? })    // → port | null
editor.removePort(nodeId, direction, portId)          // → boolean; removes attached edges too
editor.setPortLabel(nodeId, direction, portId, label) // → boolean

// Query
editor.getGraph()    // → { nodes: DAGNode[], edges: DAGEdge[] }
editor.selected      // → { kind: 'node' | 'edge', id } or null
editor.flipped       // true while the graph is shown flipped (container taller than wide)

// Import / export
editor.toJSON()             // → plain object (schema v3, positions normalised)
editor.fromJSON(data)       // load from a plain object → this
editor.exportJSON(indent?)  // → JSON string
editor.importJSON(json)     // parse and load → this
editor.loadGraph(data)      // load a plain object (v1, v2 or v3), fit view

// View and layout
editor.fitView()                    // fit the whole graph to the view
editor.autoLayout(active)           // start or stop an auto-layout run
editor.layoutActive                 // true while a run is in progress
editor.layoutPinned                 // true while pinned
editor.setLayoutPinned(on)          // pin or unpin (as Shift+L)
editor.undo()
editor.redo()
editor.destroy()                    // remove all DOM
```

---

## JSON Schema

```json
{
  "version": 3,
  "nodes": [
    {
      "id": "n1",
      "label": "Source",
      "x": 0.0, "y": 0.5,
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

**Positions are normalised.** In version 3, each node's `x` and `y` are its distance from the top-left of the graph, divided by the graph's larger extent, so that extent runs from 0 to 1 and the other axis is in proportion. A layout exported at one window size therefore looks the same when imported at another. On import, the normalised positions are placed at the smallest scale at which no two nodes overlap (with a 40 px gap), and then the view is fitted. Exporting again gives back the same numbers.

Version 2 files (positions in the editor's own units) and version 1 files are still read as they were. Version 1 graphs (single implicit port per node, `from`/`to` edge fields) are upgraded on load.

Edge routes from auto-layout are not exported: a graph read back from JSON is drawn with single or straight edges until it is laid out again.

---

## Theming

The editor follows the browser's light or dark setting (`prefers-color-scheme`). Every colour is a CSS custom property on the editor's container, `.dag-editor`, defined in `dag-editor.css` for light and dark. Override them on your own container to restyle the editor:

```css
.dag-editor {
  --dag-bg:            #f5f6fa;  /* canvas                                     */
  --dag-stroke:        #8d97bb;  /* default node outline and edge              */
  --dag-hover:         #3d63d6;  /* hovered node outline and edge              */
  --dag-selected:      #0c9c84;  /* selected node outline, edge and ports      */
  --dag-node-fill:     #ffffff;  /* node body                                  */
  --dag-node-text:     #1f2745;  /* labels                                     */
  --dag-draft:         #e0762a;  /* a line being drawn, and its drop targets   */
  /* … see dag-editor.css for the full list, and the dark values */
}
```

Nodes and edges share the same three colours: default, hovered and selected. Arrowheads take the colour of the edge they end, where the browser supports `context-stroke`.

---

## Running the tests

The component has no dependencies. The tests do: they need **Node.js 22.22 or later** (or 24.15+), and npm is used only to install the test tools ([jsdom](https://github.com/jsdom/jsdom), [puppeteer-core](https://pptr.dev/) and [c8](https://github.com/bcoe/c8)):

```sh
npm install        # once.  (npm ci installs exactly what package-lock.json says)
npm test           # everything
```

| Command | What it runs |
|---------|--------------|
| `npm test` | all the tests: unit, then browser |
| `npm run test:unit` | unit tests only — about 40 seconds, no browser needed |
| `npm run test:browser` | browser integration tests only — needs Chrome or Chromium |
| `npm run coverage` | all the tests with code coverage; **fails if coverage drops below the thresholds** in `.c8rc.json` |
| `npm run coverage:unit`, `npm run coverage:browser` | coverage of just one kind, with no threshold |

To run part of the suite, pass options to the test runner after `--`, or run a file directly:

```sh
npm run test:unit -- --test-name-pattern="flip"      # tests whose names match
node --test test/unit/layout.test.js                 # one file
```

### What is tested

* **Unit tests** (`test/unit/`) load `dag-editor.js` into [jsdom](https://github.com/jsdom/jsdom) and exercise the whole API: building graphs and the rules that keep them valid (no self-loops, duplicates or cycles), deleting with edge bridging, port editing, undo and redo, import and export (including version 1 graphs), node sizing and label wrapping, counting user-perceived characters (with and without `Intl.Segmenter`), edge curves, auto-layout, orientation and resizing, and the mouse and keyboard handlers. They also apply long **random sequences of edits** and lay out random graphs, checking after every step that the graph is still a valid DAG, that what is drawn matches the model, that nothing overlaps in either orientation, and that a layout is repeatable.
* **Browser tests** (`test/browser/`) drive the demo page in a real Chrome with [puppeteer-core](https://pptr.dev/), using real pointer, keyboard and wheel input. They check what jsdom cannot: text measured by the browser (so wrapped labels and port labels really fit), CSS states (hover, selected, port rings), flipping and re-fitting as the window is resized, the demo's full-height layout and node editor, and the event log and import/export.

jsdom does no layout, so the unit tests give the container a size, and replace the clock and `requestAnimationFrame` with a manual clock that runs animations instantly. Helpers for both kinds of test are in `test/helpers/`.

### The browser tests

They need Chrome or Chromium installed. The usual locations are searched; otherwise say where it is:

| Setting | Effect |
|---------|--------|
| `CHROME_PATH=/path/to/chrome` | use this browser |
| `PUPPETEER_HEADLESS=shell` | for a `chrome-headless-shell` build (the default is Chrome's own headless mode) |
| `HEADED=1` | show the browser window while the tests run |

```sh
CHROME_PATH=/usr/bin/chromium npm run test:browser
```

### Coverage

`npm run coverage` prints a table and writes a report to `coverage/`: open `coverage/index.html` to see which lines are not covered, or use `coverage/lcov.info` with other tools. The unit tests and the browser tests both contribute: the browser's own V8 coverage of `dag-editor.js` is collected and merged with the unit tests', so code that only runs in a real browser (such as text measurement) counts.

### Continuous integration

[`.github/workflows/test.yml`](.github/workflows/test.yml) runs on every push and pull request: the unit tests on Node 22 and 24, and the browser tests with coverage on Node 22 using the Chrome that comes with GitHub's runners. The run fails if any test fails or coverage falls below the thresholds. The coverage report is attached to each run as the `coverage-report` artifact, with a summary on the run's page.

## Origin

This code is almost entirely generated by [Claude](https://claude.ai/) and I'm not pretending otherwise.

It's inspired by the DAG editor part of [CountESS](https://countess-project.github.io/) but is an entirely
new implementation and will hopefully be useful for other projects as well.
It is [licensed CC0](LICENSE).

The full behavioural requirements that this component was designed to satisfy are in [`dag-editor-requirements.md`](dag-editor-requirements.md).
