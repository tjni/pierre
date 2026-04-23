import { describe, expect, test } from 'bun:test';

import { createSelection, SelectionDirection } from '../src/editor/selection';
import { TextDocument, type TextEdit } from '../src/editor/textDocument';

function doc(text: string) {
  return new TextDocument('inmemory://1', text, 'plain');
}

function caret(line: number, character: number) {
  return createSelection(
    line,
    character,
    line,
    character,
    SelectionDirection.None
  );
}

describe('TextDocument', () => {
  test('lang and lineCount', () => {
    const d = doc('a\nb\nc');
    expect(d.languageId).toBe('plain');
    expect(d.lineCount).toBe(3);
  });

  test('getText without range returns full buffer', () => {
    expect(doc('hello').getText()).toBe('hello');
  });

  test('getText with range', () => {
    const d = doc('aa\nbb\ncc');
    expect(
      d.getText({
        start: { line: 1, character: 0 },
        end: { line: 1, character: 1 },
      })
    ).toBe('b');
  });

  test('getLineText', () => {
    const d = doc('first\nsecond');
    expect(d.getLineText(0)).toBe('first');
    expect(d.getLineText(1)).toBe('second');
    expect(d.getLineText(-1)).toBeUndefined();
    expect(d.getLineText(99)).toBeUndefined();
  });

  test('EOF is LF for Unix newlines', () => {
    expect(doc('a\nb').EOF).toBe('\n');
  });

  test('EOF is CRLF when text uses CRLF', () => {
    expect(doc('a\r\nb').EOF).toBe('\r\n');
  });

  test('offsetAt clamps to line and document bounds', () => {
    const d = doc('ab\nc');
    expect(d.offsetAt({ line: 0, character: 0 })).toBe(0);
    expect(d.offsetAt({ line: 0, character: 99 })).toBe(2);
    expect(d.offsetAt({ line: 1, character: 0 })).toBe(3);
    expect(d.offsetAt({ line: 99, character: 0 })).toBe(d.getText().length);
  });

  test('positionAt is inverse of offsetAt for in-range columns', () => {
    const d = doc('ab\nc');
    expect(d.positionAt(0)).toEqual({ line: 0, character: 0 });
    expect(d.positionAt(3)).toEqual({ line: 1, character: 0 });
    expect(d.positionAt(d.getText().length)).toEqual({ line: 1, character: 1 });
    const { line, character } = d.positionAt(2);
    expect(d.offsetAt({ line, character })).toBe(2);
  });

  test('applyEdits single replacement', () => {
    const d = doc('hello world');
    d.applyEdits([
      {
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
        newText: 'you',
      },
    ]);
    expect(d.getText()).toBe('hello you');
  });

  test('applyEdits swaps inverted start/end', () => {
    const d = doc('abcd');
    d.applyEdits([
      {
        range: {
          start: { line: 0, character: 3 },
          end: { line: 0, character: 1 },
        },
        newText: 'X',
      },
    ]);
    expect(d.getText()).toBe('aXd');
  });

  test('applyEdits multiple non-overlapping regions', () => {
    const d = doc('aa bb cc');
    const edits: TextEdit[] = [
      {
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 8 },
        },
        newText: 'CC',
      },
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 2 },
        },
        newText: 'AA',
      },
    ];
    d.applyEdits(edits);
    expect(d.getText()).toBe('AA bb CC');
  });

  test('undo restores batch with two disjoint edits', () => {
    const d = doc('aa bb cc');
    d.applyEdits(
      [
        {
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 8 },
          },
          newText: 'CC',
        },
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 2 },
          },
          newText: 'AA',
        },
      ],
      { selectionBefore: caret(0, 0) }
    );
    d.undo();
    expect(d.getText()).toBe('aa bb cc');
  });

  test('undo multi-line replacement', () => {
    const d = doc('line1\nline2\nline3');
    d.applyEdits(
      [
        {
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 5 },
          },
          newText: 'two',
        },
      ],
      { selectionBefore: caret(1, 0) }
    );
    expect(d.getText()).toBe('line1\ntwo\nline3');
    d.undo();
    expect(d.getText()).toBe('line1\nline2\nline3');
  });

  test('undo stack depth for sequential edits', () => {
    const d = doc('');
    d.applyEdits(
      [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: 'a',
        },
      ],
      { selectionBefore: caret(0, 0), coalesceWithinMs: -1 }
    );
    d.applyEdits(
      [
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 1 },
          },
          newText: 'b',
        },
      ],
      { selectionBefore: caret(0, 1), coalesceWithinMs: -1 }
    );
    d.undo();
    expect(d.getText()).toBe('a');
    d.undo();
    expect(d.getText()).toBe('');
  });

  test('sequential edits within coalesce window undo as one entry', () => {
    const d = doc('');
    const originalNow = Date.now;
    let now = 1000;
    Object.defineProperty(Date, 'now', {
      configurable: true,
      value: () => now,
    });
    try {
      d.applyEdits(
        [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: 'a',
          },
        ],
        { selectionBefore: caret(0, 0), coalesceWithinMs: 1000 }
      );
      now += 400;
      d.applyEdits(
        [
          {
            range: {
              start: { line: 0, character: 1 },
              end: { line: 0, character: 1 },
            },
            newText: 'b',
          },
        ],
        { selectionBefore: caret(0, 1), coalesceWithinMs: 1000 }
      );
      expect(d.getText()).toBe('ab');
      d.undo();
      expect(d.getText()).toBe('');
      d.redo();
      expect(d.getText()).toBe('ab');
      expect(d.canUndo).toBe(true);
      expect(d.canRedo).toBe(false);
    } finally {
      Object.defineProperty(Date, 'now', {
        configurable: true,
        value: originalNow,
      });
    }
  });

  test('coalesced edits can update earlier inserted text', () => {
    const d = doc('x');
    const originalNow = Date.now;
    let now = 1000;
    Object.defineProperty(Date, 'now', {
      configurable: true,
      value: () => now,
    });
    try {
      d.applyEdits(
        [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            newText: 'ab',
          },
        ],
        { selectionBefore: caret(0, 0), coalesceWithinMs: 1000 }
      );
      now += 400;
      d.applyEdits(
        [
          {
            range: {
              start: { line: 0, character: 1 },
              end: { line: 0, character: 2 },
            },
            newText: 'c',
          },
        ],
        { selectionBefore: caret(0, 1), coalesceWithinMs: 1000 }
      );
      expect(d.getText()).toBe('ac');
      d.undo();
      expect(d.getText()).toBe('x');
      d.redo();
      expect(d.getText()).toBe('ac');
    } finally {
      Object.defineProperty(Date, 'now', {
        configurable: true,
        value: originalNow,
      });
    }
  });

  test('sequential edits outside coalesce window keep separate entries', () => {
    const d = doc('');
    const originalNow = Date.now;
    let now = 1000;
    Object.defineProperty(Date, 'now', {
      configurable: true,
      value: () => now,
    });
    try {
      d.applyEdits(
        [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: 'a',
          },
        ],
        { selectionBefore: caret(0, 0), coalesceWithinMs: 1000 }
      );
      now += 1200;
      d.applyEdits(
        [
          {
            range: {
              start: { line: 0, character: 1 },
              end: { line: 0, character: 1 },
            },
            newText: 'b',
          },
        ],
        { selectionBefore: caret(0, 1), coalesceWithinMs: 1000 }
      );
      d.undo();
      expect(d.getText()).toBe('a');
      d.undo();
      expect(d.getText()).toBe('');
    } finally {
      Object.defineProperty(Date, 'now', {
        configurable: true,
        value: originalNow,
      });
    }
  });

  test('applyEdits rejects overlapping ranges', () => {
    const d = doc('0123456789');
    expect(() =>
      d.applyEdits([
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 5 },
          },
          newText: 'X',
        },
        {
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 7 },
          },
          newText: 'Y',
        },
      ])
    ).toThrow('Overlapping text edits are not supported');
  });

  test('applyEdits empty array does not touch history', () => {
    const d = doc('x');
    d.applyEdits([]);
    expect(d.canUndo).toBe(false);
  });

  test('applyEdits default does not record undo', () => {
    const d = doc('a');
    d.applyEdits([
      {
        range: {
          start: { line: 0, character: 1 },
          end: { line: 0, character: 1 },
        },
        newText: 'b',
      },
    ]);
    expect(d.getText()).toBe('ab');
    expect(d.canUndo).toBe(false);
    expect(d.undo()).toBeUndefined();
  });

  test('undo and redo', () => {
    const d = doc('a');
    d.applyEdits(
      [
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 1 },
          },
          newText: 'b',
        },
      ],
      { selectionBefore: caret(0, 1) }
    );
    expect(d.getText()).toBe('ab');
    expect(d.canUndo).toBe(true);
    expect(d.canRedo).toBe(false);

    d.undo();
    expect(d.getText()).toBe('a');
    expect(d.canUndo).toBe(false);
    expect(d.canRedo).toBe(true);

    d.redo();
    expect(d.getText()).toBe('ab');
    expect(d.canUndo).toBe(true);
    expect(d.canRedo).toBe(false);
  });

  test('new edit after undo clears redo stack', () => {
    const d = doc('a');
    d.applyEdits(
      [
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 1 },
          },
          newText: 'b',
        },
      ],
      { selectionBefore: caret(0, 1) }
    );
    d.undo();
    d.applyEdits(
      [
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 1 },
          },
          newText: 'c',
        },
      ],
      { selectionBefore: caret(0, 1) }
    );
    expect(d.getText()).toBe('ac');
    expect(d.canRedo).toBe(false);
  });

  test('setText replaces content and clears history', () => {
    const d = doc('a');
    d.applyEdits(
      [
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 1 },
          },
          newText: 'b',
        },
      ],
      { selectionBefore: caret(0, 1) }
    );
    expect(d.canUndo).toBe(true);
    d.setText('fresh');
    expect(d.getText()).toBe('fresh');
    expect(d.canUndo).toBe(false);
    expect(d.canRedo).toBe(false);
  });

  test('undo on empty stack returns false', () => {
    const d = doc('z');
    expect(d.undo()).toBeUndefined();
  });

  test('redo on empty stack returns false', () => {
    const d = doc('z');
    expect(d.redo()).toBeUndefined();
  });

  test('undo and redo return stored selections', () => {
    const d = doc('abc');
    const selectionBefore = caret(0, 1);
    const selectionAfter = caret(0, 2);
    d.applyEdits(
      [
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 1 },
          },
          newText: 'x',
        },
      ],
      { selectionBefore }
    );
    d.setLastUndoSelectionAfter(selectionAfter);

    expect(d.undo()).toEqual(selectionBefore);
    expect(d.redo()).toEqual(selectionAfter);
  });

  test('undo and redo preserve multiple selections', () => {
    const d = doc('a\nb');
    const selectionBefore = [caret(0, 1), caret(1, 1)];
    const selectionAfter = [caret(0, 2), caret(1, 2)];
    d.applyEdits(
      [
        {
          range: {
            start: { line: 1, character: 1 },
            end: { line: 1, character: 1 },
          },
          newText: '!',
        },
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 1 },
          },
          newText: '!',
        },
      ],
      { selectionBefore }
    );
    d.setLastUndoSelectionAfter(selectionAfter);

    expect(d.undo()).toEqual(selectionBefore);
    expect(d.redo()).toEqual(selectionAfter);
  });
});
