'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, port } = require('../helpers/jsdom-env');

// Each of these is ONE user-perceived character, though most are several UTF-16 units / code points.
const ONE = {
  'x with a combining overline': 'x\u0305',
  'e with a combining acute': 'e\u0301',
  'family (ZWJ sequence)': '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}',
  'flag (two regional indicators)': '\u{1F1E6}\u{1F1FA}',
  'thumbs up with a skin tone': '\u{1F44D}\u{1F3FD}',
  'heart with a variation selector': '\u2764\uFE0F',
  'a plain emoji': '\u{1F600}',
  'a single letter': 'a',
};
const MANY = {
  'two letters': 'ab',
  'two digits': '12',
  'x̅ followed by y': 'x\u0305y',
  'accented a, then b': 'a\u0301b',
  'two thumbs up': '\u{1F44D}\u{1F44D}',
  'two flags': '\u{1F1E6}\u{1F1FA}\u{1F1E8}\u{1F1E6}',
  'a word': 'records',
};

function suite(name, options, { extra = {} } = {}) {
  describe(`counting user-perceived characters ${name}`, () => {
    const env = createEnv(options);
    const D = env.win.DAGEditor;
    const compactWith = label => env.editor._isCompact(env.editor.addNode('N', 0, 0, { inputs: [port('i', label)], outputs: [] }));

    for (const [what, s] of Object.entries({ ...ONE, ...extra })) {
      it(`${what} counts as one`, () => { assert.equal(D._isShortLabel(s), true); assert.equal(compactWith(s), true); });
    }
    for (const [what, s] of Object.entries(MANY)) {
      it(`${what} counts as more than one`, () => { assert.equal(D._isShortLabel(s), false); assert.equal(compactWith(s), false); });
    }
    it('an empty label, and non-strings, are short', () => {
      assert.equal(D._isShortLabel(''), true);
      assert.equal(D._isShortLabel(undefined), true);
      assert.equal(D._isShortLabel(null), true);
      assert.equal(D._isShortLabel(7), true);
      assert.equal(D._isShortLabel(77), false);
    });
    it('remembers answers, but only a bounded number of them', () => {
      for (let i = 0; i < 1500; i++) D._isShortLabel(String.fromCharCode(0x4e00 + i) + 'x');
      assert.ok(D._shortLabelCache.size <= 1000);
      assert.equal(D._isShortLabel('ab'), false);
    });
  });
}

suite('with Intl.Segmenter', {}, { extra: { 'a Hangul syllable written as three jamo': '\u1112\u1161\u11ab' } });
suite('without Intl.Segmenter (fallback)', { segmenter: false });

describe('Intl.Segmenter availability', () => {
  it('is used when present, and the editor still loads when it is absent', () => {
    assert.notEqual(createEnv().win.DAGEditor._segmenter, null);
    const bare = createEnv({ segmenter: false });
    assert.equal(bare.win.DAGEditor._segmenter, null);
    assert.doesNotThrow(() => bare.editor.addNode('N', 0, 0));
  });
});
