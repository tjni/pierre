import { describe, expect, test } from 'bun:test';

import type { EditorSelection } from '../src/editor/editorSelection';
import { SelectionDirection } from '../src/editor/editorSelection';
import { TextDocument, type TextEdit } from '../src/editor/textDocument';

function doc(text: string) {
  return new TextDocument('inmemory://1', text, 'plain');
}

function caret(line: number, character: number) {
  const position = { line, character };
  return {
    start: position,
    end: position,
    direction: SelectionDirection.None,
  } satisfies EditorSelection;
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
    expect(() => d.getLineText(-1)).toThrow('Line index out of range: -1');
    expect(() => d.getLineText(99)).toThrow('Line index out of range: 99');
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

  test('positionAt maps initial line offsets from zero', () => {
    const d = doc('first\nsecond\nthird');
    expect(d.positionAt(0)).toEqual({ line: 0, character: 0 });
    expect(d.positionAt(5)).toEqual({ line: 0, character: 5 });
    expect(d.positionAt(6)).toEqual({ line: 1, character: 0 });
    expect(d.offsetAt({ line: 2, character: 0 })).toBe(13);
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

  test('applyEdits preserves line breaks around edited line', () => {
    const d = doc('a\nb\nc');
    d.applyEdits([
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 1 },
        },
        newText: 'B',
      },
    ]);
    expect(d.getText()).toBe('a\nB\nc');
    expect(d.lineCount).toBe(3);
  });

  test('applyEdits preserves CRLF after middle-line edit', () => {
    const d = doc('a\r\nb\r\nc');
    d.applyEdits([
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 1 },
        },
        newText: 'B',
      },
    ]);
    expect(d.getText()).toBe('a\r\nB\r\nc');
  });

  test('getText(range) spans multiple lines correctly after edits', () => {
    const d = doc('foo\nbar\nbaz');
    d.applyEdits([
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 3 },
        },
        newText: 'BAR',
      },
    ]);
    expect(
      d.getText({
        start: { line: 0, character: 2 },
        end: { line: 2, character: 2 },
      })
    ).toBe('o\nBAR\nba');
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
      true,
      [caret(0, 0)]
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
      true,
      [caret(1, 0)]
    );
    expect(d.getText()).toBe('line1\ntwo\nline3');
    d.undo();
    expect(d.getText()).toBe('line1\nline2\nline3');
  });

  test('undo stack depth for sequential edits', () => {
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
              end: { line: 0, character: 0 },
            },
            newText: 'a',
          },
        ],
        true,
        [caret(0, 0)]
      );
      now += 600;
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
        true,
        [caret(0, 1)]
      );
      d.undo();
      expect(d.getText()).toBe('ax');
      d.undo();
      expect(d.getText()).toBe('x');
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
      true,
      [caret(0, 1)]
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

  test('undo and redo restore history entry versions', () => {
    const d = new TextDocument('inmemory://1', 'a', 'plain', 7);
    expect(d.version).toBe(7);

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
      true,
      [caret(0, 1)]
    );
    expect(d.version).toBe(8);

    d.undo();
    expect(d.getText()).toBe('a');
    expect(d.version).toBe(7);

    d.redo();
    expect(d.getText()).toBe('ab');
    expect(d.version).toBe(8);
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
      true,
      [caret(0, 1)]
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
      true,
      [caret(0, 1)]
    );
    expect(d.getText()).toBe('ac');
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
      true,
      [selectionBefore],
      [selectionAfter]
    );

    expect(d.undo()).toEqual([selectionBefore]);
    expect(d.redo()).toEqual([selectionAfter]);
  });

  test('undo and redo preserve multiple selections', () => {
    const d = doc('a\nb');
    const selectionsBefore = [caret(0, 1), caret(1, 1)];
    const selectionsAfter = [caret(0, 2), caret(1, 2)];
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
      true,
      selectionsBefore,
      selectionsAfter
    );

    expect(d.undo()).toEqual(selectionsBefore);
    expect(d.redo()).toEqual(selectionsAfter);
  });
});
