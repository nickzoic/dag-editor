'use strict';
/* The demo page: full-height layout, the node editor pane, event log, import / export. */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../helpers/browser');

const ed = (page, fn, ...a) => page.evaluate(fn, ...a);
const $count = (page, sel) => page.evaluate(sel => document.querySelectorAll(sel).length, sel);
const graphCounts = page => ed(page, () => { const e = window.eval('editor'); return { nodes: e.getGraph().nodes.length, edges: e.getGraph().edges.length }; });
const selectNode = async (page, label) => { const r = await B.nodeRect(page, label); await page.mouse.click(r.cx, r.cy); };
const logTypes = page => ed(page, () => [...document.querySelectorAll('#event-log .log-entry')].map(e => e.className.replace('log-entry ', '')));
const setField = async (page, selector, text) => { await page.click(selector); await page.$eval(selector, el => el.select()); await page.keyboard.type(text); };
const hidden = (page, sel) => ed(page, sel => document.querySelector(sel).hidden, sel);

describe('the page fills the window', () => {
  let b;
  before(async () => { b = await B.launch(); });
  after(async () => { await b.close(); });

  for (const [w, h] of [[1440, 900], [1000, 700], [1920, 1080]]) {
    it(`${w}×${h}: no page scrolling, the editor above the node editor, both using the full height`, async () => {
      const page = await b.newPage({ width: w, height: h });
      await B.layoutDone(page);
      const m = await ed(page, () => { const r = id => document.getElementById(id).getBoundingClientRect(), c = r('canvas-container'), p = r('node-pane'),
        hd = document.querySelector('header').getBoundingClientRect(), ft = document.querySelector('footer').getBoundingClientRect();
        return { sh: document.documentElement.scrollHeight, ih: innerHeight, sw: document.documentElement.scrollWidth, iw: innerWidth,
                 canvasBottom: c.bottom, paneTop: p.top, paneBottom: p.bottom, paneH: p.height, canvasTop: c.top, headerBottom: hd.bottom, footerTop: ft.top, footerBottom: ft.bottom, canvasW: c.width, paneW: p.width }; });
      assert.equal(m.sh, m.ih, 'the page does not scroll vertically');
      assert.equal(m.sw, m.iw, 'or horizontally');
      assert.ok(Math.abs(m.canvasTop - m.headerBottom) < 1.5, 'the editor starts under the header');
      assert.ok(Math.abs(m.canvasBottom - m.paneTop) < 1.5, 'the node editor sits directly below the editor');
      assert.ok(Math.abs(m.paneBottom - m.footerTop) < 1.5, 'and the footer directly below that');
      assert.ok(Math.abs(m.footerBottom - m.ih) < 1.5, 'so the page is filled to the bottom');
      assert.ok(Math.abs(m.canvasW - m.paneW) < 1.5, 'the editor and the node editor are the same width');
      assert.ok(m.canvasBottom - m.canvasTop > 300, 'the editor gets all the height the pane does not use');
      assert.deepEqual(page.errors, []);
      await b.closePage(page);
    });
  }
});

describe('the demo page', () => {
  let b, page;
  before(async () => { b = await B.launch(); });
  after(async () => { await b.close(); });
  beforeEach(async () => {
    if (page) await b.closePage(page);
    page = await b.newPage({ width: 1440, height: 900 });
    await B.layoutDone(page);
  });

  describe('when it opens', () => {
    it('shows the 12-node, 15-edge sample, already laid out', async () => {
      assert.deepEqual(await graphCounts(page), { nodes: 12, edges: 15 });
      assert.equal((await B.editorState(page)).active, false);
      assert.ok(await B.allNodesInside(page));
    });

    it('has nothing selected and an empty log', async () => {
      assert.equal(await hidden(page, '#np-body'), true);
      assert.equal(await hidden(page, '#np-empty'), false);
      assert.deepEqual(await logTypes(page), ['placeholder']);
    });

    it('covers nodes with no, one and several inputs and outputs, compact and expanded, labelled and not', async () => {
      const r = await ed(page, () => { const e = window.eval('editor'), ns = e.getGraph().nodes, labelled = n => [...n.inputs, ...n.outputs].some(p => p.label);
        const compact = ns.filter(n => e._isCompact(n)), expanded = ns.filter(n => !e._isCompact(n));
        return { in0: ns.some(n => !n.inputs.length), in1: ns.some(n => n.inputs.length === 1), inN: ns.some(n => n.inputs.length > 1),
                 out0: ns.some(n => !n.outputs.length), out1: ns.some(n => n.outputs.length === 1), outN: ns.some(n => n.outputs.length > 1),
                 cPlain: compact.some(n => !labelled(n)), cLabelled: compact.some(labelled), eLabelled: expanded.some(labelled),
                 eMixed: expanded.some(n => [...n.inputs, ...n.outputs].some(p => !p.label)), cMulti: compact.some(n => n.inputs.length > 1) && compact.some(n => n.outputs.length > 1) }; });
      for (const [k, v] of Object.entries(r)) assert.equal(v, true, k);
    });
  });

  describe('the node editor', () => {
    it('shows the selected node\'s label and ports, with how many edges each port has', async () => {
      await selectNode(page, 'Enrich');
      assert.equal(await hidden(page, '#np-body'), false);
      assert.equal(await ed(page, () => document.getElementById('np-label').value), 'Enrich');
      assert.equal(await $count(page, '#np-inputs .np-port'), 2);
      assert.equal(await $count(page, '#np-outputs .np-port'), 2);
      assert.deepEqual(await ed(page, () => [...document.querySelectorAll('#np-outputs .np-port')].map(r => [r.querySelector('.np-pid').textContent, r.querySelector('input').value, r.querySelector('.np-edges').textContent])),
        [['enriched', 'enriched', '1 edge'], ['rejects', 'rejects', '1 edge']]);
      assert.equal(await ed(page, () => document.getElementById('np-nodeid').textContent), 'n8');
    });

    it('says when a node has no ports on a side', async () => {
      await selectNode(page, 'Customers');
      assert.equal(await ed(page, () => document.querySelector('#np-inputs .np-none').textContent), 'No input ports');
    });

    it('typing in the label field renames the node as you type, and keeps the cursor there', async () => {
      await selectNode(page, 'Parse');
      await setField(page, '#np-label', 'Tokenise');
      assert.equal(await ed(page, () => window.eval('editor').getGraph().nodes.find(n => n.id === 'n4').label), 'Tokenise');
      assert.ok(await B.nodeRect(page, 'Tokenise'));
      assert.equal(await ed(page, () => document.activeElement.id), 'np-label');
      assert.equal(await ed(page, () => document.getElementById('np-label').value), 'Tokenise');
    });

    it('the whole rename is one undo step', async () => {
      await selectNode(page, 'Parse');
      await setField(page, '#np-label', 'Tokenise');
      await ed(page, () => window.eval('editor').undo());
      assert.equal(await ed(page, () => window.eval('editor').getGraph().nodes.find(n => n.id === 'n4').label), 'Parse');
      assert.equal(await hidden(page, '#np-body'), true, 'undo clears the selection, so the pane empties');
    });

    it('Enter in a field leaves it', async () => {
      await selectNode(page, 'Parse');
      await page.click('#np-label'); await page.keyboard.press('Enter');
      assert.notEqual(await ed(page, () => document.activeElement.id), 'np-label');
    });

    it('shortcut keys typed into the fields are text, not commands', async () => {
      await selectNode(page, 'Parse');
      const n0 = (await graphCounts(page)).nodes;
      await setField(page, '#np-label', 'nlnlnn');
      await page.keyboard.press('Backspace'); await page.keyboard.press('Delete');
      assert.equal((await graphCounts(page)).nodes, n0, 'no node was created, laid out or deleted');
      assert.equal(await ed(page, () => document.getElementById('np-label').value), 'nlnln');
    });

    it('editing a port label changes the port, and a long enough label expands a compact node', async () => {
      await selectNode(page, 'Customers');
      assert.equal(await ed(page, () => document.querySelector('[data-id="n1"]').classList.contains('dag-node--compact')), true);
      await setField(page, '#np-outputs .np-port input', 'Z');
      assert.equal(await ed(page, () => window.eval('editor').getGraph().nodes[0].outputs[0].label), 'Z');
      assert.equal(await ed(page, () => document.querySelector('[data-id="n1"]').classList.contains('dag-node--compact')), true, 'one character: still compact');
      await page.keyboard.type('Z');
      assert.equal(await ed(page, () => document.querySelector('[data-id="n1"]').classList.contains('dag-node--compact')), false, 'two characters: expanded');
      assert.equal(await ed(page, () => document.activeElement.closest('#np-outputs') !== null), true, 'and the cursor is still in the field');
    });

    it('removing a port removes the edges attached to it', async () => {
      await selectNode(page, 'Enrich');
      const before = await graphCounts(page);
      await ed(page, () => { document.querySelector('#event-log').replaceChildren(); });
      await page.click('#np-outputs .np-port:nth-child(2) .np-del');           // the "rejects" output, which has one edge
      const after = await graphCounts(page);
      assert.equal(after.edges, before.edges - 1);
      assert.equal(await $count(page, '#np-outputs .np-port'), 1);
      assert.equal(await $count(page, '[data-id="n8"] circle[data-port-uid="rejects:out"]'), 0, 'the dot is gone from the canvas');
      assert.deepEqual((await logTypes(page)).reverse(), ['edge-deleted', 'updated']);
    });

    it('removing a port with no edges removes just the port', async () => {
      await selectNode(page, 'Dashboard');
      const before = await graphCounts(page);
      await page.click('#np-inputs .np-port:nth-child(2) .np-del');           // the unlabelled, unconnected input
      assert.deepEqual(await graphCounts(page), before);
      assert.equal(await $count(page, '#np-inputs .np-port'), 1);
    });

    it('+ Add input and + Add output add a port and put the cursor in its label', async () => {
      await selectNode(page, 'Parse');
      await page.click('#np-add-input');
      assert.equal(await $count(page, '#np-inputs .np-port'), 2);
      assert.equal(await ed(page, () => document.activeElement === document.querySelector('#np-inputs .np-port:last-child input')), true);
      await page.keyboard.type('q');
      assert.equal(await ed(page, () => window.eval('editor').getGraph().nodes.find(n => n.id === 'n4').inputs[1].label), 'q');
      await page.click('#np-add-output');
      assert.equal(await $count(page, '#np-outputs .np-port'), 2);
    });

    it('follows changes made on the canvas: connecting a port updates its edge count', async () => {
      await selectNode(page, 'Customers');
      assert.equal(await ed(page, () => document.querySelector('#np-outputs .np-edges').textContent), '1 edge');
      await ed(page, () => window.eval('editor').addEdge('n1', 'out', 'n12', 'extra'));
      assert.equal(await ed(page, () => document.querySelector('#np-outputs .np-edges').textContent), '2 edges');
    });

    it('empties when the node is deselected or deleted', async () => {
      await selectNode(page, 'Parse');
      assert.equal(await hidden(page, '#np-body'), false);
      await ed(page, () => window.eval('editor')._container.focus());
      await page.keyboard.press('Escape');
      assert.equal(await hidden(page, '#np-body'), true);
      await selectNode(page, 'Parse');
      await ed(page, () => window.eval('editor')._container.focus());
      await page.keyboard.press('Delete');
      assert.equal(await hidden(page, '#np-body'), true);
      assert.equal((await graphCounts(page)).nodes, 11);
    });
  });

  describe('the event log', () => {
    it('records what happens, newest first', async () => {
      await selectNode(page, 'Parse');
      await setField(page, '#np-label', 'X');
      const types = await logTypes(page);
      assert.equal(types[0], 'updated');
      assert.ok(types.includes('selected'));
    });

    it('shows labels as plain text, never as HTML', async () => {
      await selectNode(page, 'Parse');
      await setField(page, '#np-label', '<img src=x onerror="window.__xss=1">');
      await B.sleep(100);
      assert.equal(await $count(page, '#event-log img'), 0);
      assert.equal(await ed(page, () => window.__xss), undefined);
      assert.match(await ed(page, () => document.querySelector('#event-log .log-entry').textContent), /<img src=x/);
    });

    it('keeps only the most recent 40 entries', async () => {
      await ed(page, () => { const e = window.eval('editor'); for (let i = 0; i < 60; i++) e.addNode('N' + i, i, i); });
      assert.equal(await $count(page, '#event-log .log-entry'), 40);
    });
  });

  describe('import and export', () => {
    it('Export JSON fills the box with the graph, in version 2', async () => {
      await page.click('#export-btn');
      const json = JSON.parse(await ed(page, () => document.getElementById('json-out').value));
      assert.equal(json.version, 2);
      assert.equal(json.nodes.length, 12);
      assert.equal(json.edges.length, 15);
    });

    it('Import JSON loads whatever is in the box, and clears the log', async () => {
      await page.click('#export-btn');
      await ed(page, () => { const t = document.getElementById('json-out'); t.value = t.value.replace('"Customers"', '"Renamed"'); });
      await page.click('#import-btn');
      assert.ok(await B.nodeRect(page, 'Renamed'));
      assert.deepEqual(await logTypes(page), ['placeholder']);
    });

    it('Import JSON with nothing in the box does nothing; with bad JSON it says so', async () => {
      await ed(page, () => { document.getElementById('json-out').value = ''; });
      await page.click('#import-btn');
      assert.deepEqual(await graphCounts(page), { nodes: 12, edges: 15 });
      const dialog = new Promise(res => page.once('dialog', d => { const m = d.message(); d.dismiss(); res(m); }));
      await ed(page, () => { document.getElementById('json-out').value = '{ not json'; });
      await page.click('#import-btn');
      assert.match(await dialog, /Import failed/);
      assert.deepEqual(await graphCounts(page), { nodes: 12, edges: 15 });
    });

    it('Load sample graph restores the sample, laid out exactly as at the start', async () => {
      const start = (await B.editorState(page)).json;
      await ed(page, () => { window.eval('editor').deleteNode('n6'); });
      await page.click('#sample-btn');
      await B.layoutDone(page);
      assert.equal((await B.editorState(page)).json, start);
      assert.deepEqual(await logTypes(page), ['placeholder']);
    });
  });

  it('ran without script errors', () => assert.deepEqual(page.errors, []));
});
