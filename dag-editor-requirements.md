# DAGEditor — Requirements

A standalone, zero-dependency interactive editor for directed acyclic graphs, implemented in plain JavaScript and CSS. It is initialised with a container `<div>` and a callback, and all interaction happens within that container.

---

## 1. Graph Model

### 1.1 Nodes

- Each node has a unique string ID, a display label, a position (x, y), and zero or more named input ports and zero or more named output ports.
- Each port has a unique-within-node ID and an optional display label.
- Node labels must be unique across all nodes. When a node is created without an explicit label, generate a name that does not already exist in the graph (e.g. "Node", "Node 2", "Node 3", …). Labels the user later types in are not forced to be unique.
- A node is **expanded** if any of its port labels is longer than one user-perceived character; otherwise it is **compact**. A node can therefore have any number of ports on a side and stay compact, provided every port label is empty or a single character. Only port labels count — the node's own label never affects compactness.
- User-perceived characters are grapheme clusters, counted with `Intl.Segmenter` (grapheme granularity), so for example `x̅` (x + combining overline), `é` written as `e` + combining accent, a flag, a skin-toned emoji and a ZWJ emoji sequence each count as one character. Where `Intl.Segmenter` is unavailable the editor must still work, using an approximation that folds combining marks, variation selectors, skin tones, ZWJ sequences and flag pairs into one character.

### 1.2 Edges

- Each edge connects a specific output port of one node to a specific input port of another node.
- Edges are directed: they have a source (output port) and a destination (input port).

### 1.3 Validity Rules

- **No self-loops**: an edge cannot connect a node to itself.
- **No duplicate edges**: at most one edge per (source node, source port, destination node, destination port) tuple.
- **No cycles**: the graph must remain a DAG at all times. Any operation that would introduce a cycle is silently rejected.

---

## 2. Visual Appearance

### 2.1 Canvas

- The editor fills its container. The canvas has a dot-grid background.
- The canvas can be panned (Alt + drag) and zoomed (scroll wheel, clamped to a sensible range).

### 2.2 Nodes

- Nodes are rounded rectangles. Output ports are on the right edge; input ports are on the left edge.
- **Compact nodes** (see §1.1): there is no header or divider. The label is vertically centred. The ports on each side form a stack, evenly spaced and centred on the node (a lone port sits at the vertical midpoint). The node is tall enough to hold its tallest stack. Port labels (always at most one user-perceived character) are shown next to the port dot when non-empty.
- **Expanded nodes**: the label sits at the top with a horizontal divider below it. Ports are evenly spaced below the divider, and each port has its label shown inside the node body next to the dot.
- **Label wrapping** (both layouts): a long node label wraps onto several lines at word boundaries, and a single word wider than a line is broken across lines. Labels are never truncated. The node grows taller to fit every line — in a compact node the label block stays centred, in an expanded node the header, divider and ports move down. Runs of whitespace in a label collapse when displayed.
- Node height, port positions, hit-testing and edge endpoints always follow the node's actual height.
- Port dots are always visible with a dim border. When the cursor is over a node, the port borders brighten. When the cursor is directly over a port dot, the dot fills solid.
- An unselected node gets a brightened outline and a subtle glow when hovered.
- A selected node renders in a distinct colour scheme (teal fill and teal border) clearly different from both the resting and hovered states. Its port dots also use the teal colour.
- When a selected node is hovered, the selection colour is preserved — the hover state does not override it.

### 2.3 Edges

- Edges are drawn as smooth cubic Bézier splines.
- The spline starts at the surface of the output port dot and ends with an arrowhead whose tip touches the surface of the input port dot (accounting for the port stroke width).
- An edge that is not routed (§5.5) is drawn as one spline. When the angle between the two ports is shallow (|Δy| ≤ |Δx|): the spline departs and arrives horizontally. Control handles are horizontal, length ≈ 35% of Δx (minimum 30 px).
- When the angle is steep (|Δy| > |Δx|): the spline departs and arrives at 45° to horizontal. The path starts and ends at the port surface measured at 45°, and the control handles extend diagonally at 45°, length ≈ 35% of Δy (minimum 30 px).
- A **long** edge (one that runs across one or more columns, §5.5) is drawn **straight**, from port to port, whenever nothing is in its way. Only if its straight line would pass through another node is it drawn through the lanes its layout gave it: a chain of splines, flat across each column at that lane's height, rising or falling only in the gap between columns. If the lanes are blocked too, it falls back to a single curve. An edge to the next column is drawn through the gap between the two columns. Arrowheads are on the last piece. Flipped (§13), the same drawing runs down the screen.
- The arrowhead is backed off by half the port stroke-width so it meets the port edge cleanly.
- Edges render on top of nodes so they are always visible even if layout forces a node underneath.
- An unselected edge gets a slightly brighter stroke when hovered.
- A selected edge renders in teal with a glow. This colour is preserved when hovered — the hover state does not override it. The arrowhead matches the edge colour.

### 2.4 Draft Edge

- While dragging a port to draw a new edge, a dashed orange preview line is shown from the port surface to the cursor.
- Compatible target ports (input ports when dragging from an output, and vice versa) are highlighted in orange when the cursor is near them.

### 2.5 Toolbar

- A toolbar at the top of the container contains buttons: **+ Node**, **Delete**, **↩ Undo**, **↪ Redo**, **Fit**, **⟳ Layout**.
- A hint bar at the bottom of the container shows brief interaction guidance.

---

## 3. Interaction — Mouse

### 3.1 Adding Nodes

- Clicking on empty canvas creates a new node at the cursor position.

### 3.2 Selecting

- Clicking on a node selects it.
- Clicking on an edge selects it.
- Clicking on empty canvas deselects.

### 3.3 Moving

- Dragging a node body moves it.

### 3.4 Drawing Edges

- Dragging from an **output port** (right side) starts drawing an edge. Dropping on:
  - An input port or node body → connects the edge to that node's (first) input port.
  - Empty canvas → creates a new node at the drop position and connects to it.
- Dragging from an **input port** (left side) starts drawing an edge in reverse. Dropping on:
  - An output port or node body → connects the edge from that node's (first) output port.
  - Empty canvas → creates a new node at the drop position and connects from it.
- If the connection would violate the validity rules (§1.3), it is rejected.

### 3.5 Editing Labels and Ports

- The canvas has **no** inline label editor: double-clicking a node or pressing Enter does nothing. Node labels and ports are edited through the programmatic API (§9); the host page supplies the UI.

### 3.6 Inserting a Node on an Edge

- Double-clicking on an edge inserts a new compact node at the click position, removes the original edge, and wires two new edges through the new node: upstream → new node input, new node output → downstream.

### 3.7 Deleting

- With a node selected, pressing Delete/Backspace deletes the node and all its connected edges.
- **Edge bridging**: if the deleted node has exactly one input port and one output port, new edges are automatically created connecting every upstream source directly to every downstream target. Connections that would form self-loops, duplicates, or cycles are skipped.
- With an edge selected, Delete/Backspace deletes only that edge.
- The Delete toolbar button performs the same action.

### 3.8 Navigation

- Scroll wheel zooms the canvas (centred on cursor).
- Alt + drag pans the canvas.

---

## 4. Interaction — Keyboard

| Key | Action |
|-----|--------|
| `Delete` / `Backspace` | Delete selected node or edge |
| `Escape` | Deselect |
| `N` | Create a new node at the canvas centre |
| `Tab` / `Shift+Tab` | Cycle node selection forward/backward |
| `L` | Toggle one-shot auto-layout |
| `Shift+L` | Toggle pinned auto-layout |
| `Ctrl+Z` / `Cmd+Z` | Undo |
| `Ctrl+Shift+Z` / `Cmd+Y` | Redo |

---

## 5. Auto-Layout

### 5.1 Behaviour

- Auto-layout animates node positions in real time: each node glides smoothly from where it is to its new position.
- During layout, the view is continuously fitted to show the full graph.
- After the layout ends, the final positions are saved as an undo step.
- Layout is deterministic: the same graph in the same arrangement always produces the same result. Laying out a large graph must not freeze the page, so the effort spent on ordering and refinement is reduced as the graph grows (small graphs get the full effort).

### 5.2 Layout Rules

- Nodes are sorted into **strata** (columns) by their longest-path depth from any root (stratum 0 = roots). Every node in a stratum has the same x, and strata are a fixed distance apart. Roots are on the left, leaves on the right, and every edge points left to right.
- Within each stratum, nodes are ordered vertically to minimise edge crossings. Edges are considered port by port, so the order of a node's ports counts too.
- **Nodes never overlap, in either orientation.** Within a stratum there is always a minimum gap between nodes, and strata are far enough apart, measured so that the same positions also work when the graph is shown flipped (§13): the room a node needs along its column is the larger of its unflipped height and its flipped width, and the distance between strata allows for the tallest flipped node.
- The best of several attempts is kept (the current order as it stands, the current order with crossing-reduction sweeps, its reverse, and fixed-seed shuffles), so the result is good whatever the starting arrangement; the current order wins ties, so laying out a layout that is already good leaves it unchanged.
- Positions are rounded to 0.01 px.
- Connected ports are lined up horizontally where possible (edges tend toward horizontal), subject to the minimum gap.
- Every edge runs from left to right. An edge that spans more than one column is given a lane between the nodes of each column it crosses, and its route passes through those lanes, so it never cuts through a node it does not join (§5.5). Because each route rises or falls only in the gaps between columns, which hold no nodes, this holds in either orientation.
- The layout is anchored so its topmost node is at y = 0, so repeated layouts do not drift.
- A graph with no nodes, or a single node, lays out without error.

### 5.5 Edge Routes

- A layout records the route of every edge that runs from one column to a later one: the points at the centres of the lanes it reserved in the columns between its ends (in unflipped coordinates). An edge between adjacent columns has no points, and its route is a single rise or fall in the gap between the columns.
- Each long edge has a route, made when the layout ran. The route is used only while it is still good: the columns must still be the width they were laid out at, and the curve as drawn now must pass clear of every node except the two it joins. A long edge is drawn straight in preference to its route, whenever the straight line is clear.
- So a node only affects the edges whose drawn curves it now lies across. A small move keeps every route. A node moved onto a long edge's straight line makes that edge use its lanes; a node moved onto both its straight line and its lanes makes it a single curve (§2.3) until the next layout. Edges whose drawings it does not touch are unchanged.
- A change that alters the column width (for example, a node that becomes taller than any other) drops every route, since the lanes are placed by it.
- A relabel that changes nothing about the geometry keeps every route.
- Undoing or redoing back to the laid-out state restores the routes, because they depend only on the positions, sizes and ports of nodes and on the edges.
- Routes are not exported. A graph imported from JSON is drawn with single curves until it is laid out.
- The layout treats routes as it draws them: the search for a good arrangement counts the routes that cut through a node, so the arrangement it keeps is one whose routes are clear.

### 5.3 Stopping Conditions

Nodes glide toward their positions with a short time constant. The run ends when every node is within 0.5 px of its position (typically well under a second), or at a fixed deadline of 1500 ms at the latest. Either way, nodes finish exactly on their positions.

### 5.4 Layout Modes

**One-shot** (`L` key or single-click on the Layout button):
- Runs once and stops.
- The Layout button pulses blue while running.

**Pinned** (`Shift+L` or double-click on the Layout button):
- Automatically re-runs a full layout whenever the graph changes (edge added, edge removed, node deleted, graph loaded).
- Creating an isolated node with no edges does **not** trigger a re-run.
- If a run is already in progress when a change occurs, the timer is reset for a full run from that point.
- The Layout button pulses teal (visually distinct from one-shot) while pinned.
- Double-clicking or `Shift+L` again unpins and stops any active run.

---

## 6. Fit to View

- The **Fit** toolbar button scales and pans the canvas so all nodes are visible with padding on all sides.
- Fit also runs automatically after auto-layout and after loading a graph.

---

## 7. Undo / Redo

- Every graph mutation is undoable: creating nodes, deleting nodes/edges, moving nodes (on drag end), changing labels, adding/removing ports, drawing edges, loading a graph.
- Undo/redo stack depth: at least 100 steps.
- The first undo reverts the most recent change (the initial state is the undo baseline).
- Redoing is only possible if no mutation has occurred since the last undo.
- A burst of edits to the same label (e.g. typing) is one undo step.
- Undo, redo and loading a graph clear the selection.

---

## 8. Notifications (onChange Callback)

The callback receives a plain event object for every graph change:

| `type` | Payload | Fired when |
|--------|---------|------------|
| `'created'` | `node: DAGNode` | A node is created |
| `'selected'` | `node: DAGNode` | A node is selected |
| `'deselected'` | `node: DAGNode` | A node stops being selected (another node or edge selected, selection cleared, graph replaced, undo/redo) |
| `'updated'` | `node: DAGNode` | A node's label changes, or one of its ports is added, removed or relabelled |
| `'deleted'` | `node: DAGNode` | A node is deleted |
| `'edge-created'` | `edge: DAGEdge` | An edge is created (including bridge edges) |
| `'edge-deleted'` | `edge: DAGEdge` | An edge is deleted (including edges removed with their node) |

When a node with 1-in-1-out is deleted and edges are bridged, the event order is: `edge-deleted` for each removed edge, then `deleted` for the node, then `edge-created` for each bridge edge.

When a port is removed, the order is: `edge-deleted` for each edge that was attached to it, then `updated` for the node.

---

## 9. Programmatic API

The editor exposes the following methods for programmatic control:

```
addNode(label, x?, y?, { inputs?, outputs? })  → DAGNode
addEdge(fromNodeId, fromPortId, toNodeId, toPortId)  → boolean
deleteNode(id)
deleteEdge(id)
setNodeLabel(nodeId, label)                     → boolean
addPort(nodeId, direction, { id?, label? })     → port | null
removePort(nodeId, direction, portId)           → boolean
setPortLabel(nodeId, direction, portId, label)  → boolean
getGraph()  → { nodes: DAGNode[], edges: DAGEdge[] }
loadGraph(data)         // replaces current graph; fires no events
autoLayout(active)      // programmatic layout control
toJSON()                // → plain object (version 2 schema)
fromJSON(data)          // load from plain object (v1 or v2)
exportJSON(indent?)     // → JSON string
importJSON(json)        // parse and load
undo()
redo()
destroy()               // remove all DOM
```

All valid node and edge operations fire the appropriate `onChange` events.

### 9.1 Node and Port Editing

- `direction` is `'input'` or `'output'`; anything else is an error.
- `addPort` generates an id unique within that side of the node (`in`, `in2`, … / `out`, `out2`, …) unless one is given; it returns `null` if the node is unknown or the given id is already used on that side. New ports have an empty label unless given one.
- `removePort` removes the port **and every edge attached to it**; if the selected edge is one of them, the selection is cleared. Returns `false` for an unknown node or port.
- Adding or removing a port, or changing a port label, can switch a node between compact and expanded (§1.1); the change is visible immediately. Changing a node label re-wraps it and resizes the node.
- A pinned auto-layout re-runs when removing a port deletes edges, but not for label changes or for adding a port.
- Each operation is one undo step (except repeated edits of one label, see §7).

### 9.2 Container Sizing

- The editor fills its container. It only applies a default height (480 px) when the page's CSS leaves the container with no height at all, so a container sized by a flex or grid layout is respected.

---

## 10. Import / Export

### 10.1 JSON Schema (version 2)

```json
{
  "version": 2,
  "nodes": [
    {
      "id": "n1",
      "label": "My Node",
      "x": 100,
      "y": 80,
      "inputs":  [{ "id": "in",  "label": "data" }],
      "outputs": [{ "id": "out", "label": "result" }]
    }
  ],
  "edges": [
    {
      "id": "e1",
      "fromNodeId": "n1",
      "fromPortId": "out",
      "toNodeId":   "n2",
      "toPortId":   "in"
    }
  ]
}
```

Edge routes from auto-layout (§5.5) are not part of the export: a graph read back from JSON is drawn with single curves until it is laid out again.

### 10.2 Version 1 Compatibility

Version 1 graphs (nodes without ports, edges with `from`/`to` instead of `fromNodeId`/`toNodeId`) are automatically upgraded on load: each node gains a single input port (`id: "in"`) and a single output port (`id: "out"`); each edge's `from`/`to` are mapped to `fromNodeId`/`toNodeId` with `fromPortId: "out"` and `toPortId: "in"`.

---

## 11. Visual Design (Dark Theme)

- Dark navy/charcoal backgrounds throughout.
- Two primary accent colours: **blue** (port highlights, one-shot layout, general selection affordances) and **teal** (node selection, selected edges, pinned layout).
- The draft edge colour is **orange**.
- Port dots use a consistent colour across their three states: dim (rest), blue ring (node hovered), solid blue (port hovered), teal (selected node), orange (drop target).
- Edge states: dim (rest), slightly brighter (hovered), teal with glow (selected).
- All colour values and spacing constants are defined as CSS custom properties so they can be overridden.

---

## 12. Demo Page

The demo (`dag-editor-demo.html`) loads `dag-editor.css` and `dag-editor.js` as separate files and shows the component in use.

### 12.1 Layout

- The page fills the full viewport height with no page scroll: a slim header, a workspace that takes all remaining height, and a slim footer.
- In the workspace, the graph editor is stacked above a **node editor pane** in the left column; the graph editor takes all height not used by the pane. The sidebar (event log, import/export, shortcut list, sample loader) is on the right.

### 12.2 Node Editor Pane

- Shows a placeholder until a node is selected; clears again when that node is deselected or deleted.
- For the selected node it shows an editable **label** field and two lists, **Inputs** and **Outputs**. Each port row shows the port id, an editable label field, the number of edges attached (when any), and a remove button. Each list has an **Add** button; a newly added port's label field takes focus.
- Typing in a label field updates the node on the canvas live.
- Removing a port that has edges also removes those edges (the row and button make the edge count visible beforehand).
- The pane stays in sync with changes made on the canvas (edges added or removed) but never rebuilds itself while the user is typing in it.

### 12.3 Event Log

- Logs every `onChange` event, including `deselected` and `updated`. User-supplied labels are shown as plain text, never interpreted as HTML.

### 12.4 Default Sample Graph

- The demo opens with a sample graph already loaded. Once all its nodes and edges are configured it runs auto-layout once. The event log starts empty, and no node is selected.
- The **Load sample graph** button restores the sample and lays it out again, giving the same result each time.
- The sample has 12 nodes and 15 edges, a representative selection across these categories:
  - input ports: none, one, several;
  - output ports: none, one, several;
  - compact nodes without port labels, and with one-character port labels (including several ports on a side);
  - non-compact nodes with port labels, and one with a mix of labelled and unlabelled ports. (A non-compact node always has at least one port label longer than one character, so a non-compact node with no port labels at all cannot exist; the mixed node is the nearest case.)
- Every edge connects ports that exist, and the sample is a valid DAG that includes fan-in on one port, fan-out from one port, and edges spanning several columns.

### 12.5 README Screenshot

- The README shows a screenshot of the demo directly under its title: the sample graph after its automatic layout, with one node selected so that the selection styling and the node editor pane are visible.

---

## 13. Orientation (Portrait Mode)

### 13.1 When the graph is flipped

- The graph is shown **flipped** when the container the editor is rendered in is strictly taller than it is wide, and unflipped otherwise (a square or empty container is unflipped).
- Whenever the container is resized, the orientation is chosen again and the graph is **fitted to the new size and orientation**, even if the orientation did not change. Resizing never changes any node's position.

### 13.2 What flipping looks like

- The X and Y axes are swapped: **inputs are on the top edge** of each node, **outputs on the bottom edge**, and the **strata run from top to bottom**. Edges leave an output heading down and arrive at an input heading down, using the same curve rules as unflipped (including the 45° rule for edges that run more sideways than down), with arrowheads on the input end.
- **Relative positions are kept**: each node's centre is transposed, so a node near the top of the pane when horizontal is near the left of the pane when vertical.
- Ports are spread evenly along the edge (see below), so a node's ports do not sit exactly where the unflipped layout lined them up; a lone port on a compact node is in the middle, as it is unflipped. Edges between ports that line up unflipped may therefore curve slightly when flipped.
- **All text stays upright**; nothing is rotated or mirrored. Node labels wrap as usual. Each port label sits just inside the edge, centred under (inputs) or over (outputs) its port.
- **Ports are evenly distributed across the node's width**, independently on the top and bottom edges: n ports sit at 1/(n+1), 2/(n+1) … n/(n+1) of the width (one port in the middle, two at thirds, three at quarters), whatever the lengths of their labels. The node is made wide enough that each gap between ports (and between the end ports and the node's sides) is at least 22 px and at least the widest label on that edge plus a small gap; otherwise it keeps the 120 px minimum width. (Port labels are short and nodes rarely have more than a few ports, so the minimum width is normally enough.)
- Expanded nodes have a divider between the label and each port-label row. Flipped nodes are at least 120 px wide.
- The compact / expanded rule is unchanged.

### 13.3 Positions and export

- `node.x` and `node.y` (and so every export, `getGraph()`, events, and the positions accepted by `addNode`, `fromJSON` and `loadGraph`) are **always in the unflipped orientation**, whatever is being shown. Flipping a graph and exporting it gives exactly the same data as before flipping.
- Interaction works in the orientation shown, converted to and from unflipped positions: dragging a node follows the pointer; a node created by clicking, by dropping an edge on empty canvas, by double-clicking an edge, or by the New node button/key is centred where it was asked for; the draft edge, port highlighting, hit-testing and selection all use what is drawn.
- `editor.flipped` reports whether the graph is currently shown flipped.

