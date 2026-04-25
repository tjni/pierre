import { describe, expect, test } from 'bun:test';

import {
  applyOffsetEdits,
  buildInverseOffsetEdits,
  EditHistory,
} from '../src/editor/editHistory';
import type { EditorSelection } from '../src/editor/selection';
import { SelectionDirection } from '../src/editor/selection';

function createSelection(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
  direction: SelectionDirection = SelectionDirection.None
): EditorSelection {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
    direction,
  };
}

function caret(character: number) {
  return createSelection(0, character, 0, character, SelectionDirection.None);
}

describe('EditHistory helpers', () => {
  test('applyOffsetEdits sorts edits and applies them in offset space', () => {
    expect(
      applyOffsetEdits('0123456789', [
        { start: 8, end: 10, text: 'YZ' },
        { start: 1, end: 4, text: 'AB' },
      ])
    ).toBe('0AB4567YZ');
  });

  test('assertNonOverlappingDescending rejects overlapping edits', () => {
    expect(() =>
      applyOffsetEdits('0123456789', [
        { start: 6, end: 8, text: 'X' },
        { start: 4, end: 7, text: 'Y' },
      ])
    ).toThrow('Overlapping text edits are not supported');
  });

  test('buildInverseOffsetEdits restores the original text for mixed edits', () => {
    const textBefore = 'abcde';
    const forwardEdits = [
      { start: 1, end: 2, text: 'XY' },
      { start: 4, end: 5, text: '' },
    ];

    const textAfter = applyOffsetEdits(textBefore, forwardEdits);
    const inverseEdits = buildInverseOffsetEdits(textBefore, forwardEdits);

    expect(textAfter).toBe('aXYcd');
    expect(inverseEdits).toEqual([
      { start: 1, end: 3, text: 'b' },
      { start: 5, end: 5, text: 'e' },
    ]);
    expect(applyOffsetEdits(textAfter, inverseEdits)).toBe(textBefore);
  });
});

describe('EditHistory', () => {
  test('push stores cloned selections and pop methods move entries between stacks', () => {
    const history = new EditHistory();
    const selectionBefore = [caret(0), caret(1)];
    const selectionAfter = [caret(2), caret(3)];

    history.push(
      'ab',
      [{ start: 1, end: 1, text: 'X' }],
      selectionBefore,
      selectionAfter
    );

    selectionBefore[0] = caret(99);
    selectionAfter[0] = caret(99);

    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);

    const entry = history.popUndoToRedo();

    expect(entry).toEqual({
      forwardEdits: [{ start: 1, end: 1, text: 'X' }],
      inverseEdits: [{ start: 1, end: 2, text: '' }],
      textLengthBefore: 2,
      textLengthAfter: 3,
      selectionsBefore: [caret(0), caret(1)],
      selectionsAfter: [caret(2), caret(3)],
    });
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);

    expect(history.popRedoToUndo()).toEqual(entry);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
  });

  test('setLastUndoSelectionsAfter stores cloned redo selections', () => {
    const history = new EditHistory();
    let selectionAfter = caret(2);

    history.push(
      'a',
      [{ start: 1, end: 1, text: 'b' }],
      [caret(1)],
      [selectionAfter]
    );
    selectionAfter = caret(99);

    expect(history.popUndoToRedo()).toMatchObject({
      selectionsAfter: [caret(2)],
    });
  });

  test('push clears redo history when recording a new undo entry', () => {
    const history = new EditHistory();

    history.push('', [{ start: 0, end: 0, text: 'a' }], [caret(0)], undefined);
    history.push('a', [{ start: 1, end: 1, text: 'b' }], [caret(1)], undefined);

    expect(history.popUndoToRedo()).toMatchObject({
      forwardEdits: [{ start: 1, end: 1, text: 'b' }],
    });
    expect(history.canRedo).toBe(true);

    history.push('a', [{ start: 1, end: 1, text: 'c' }], [caret(1)], undefined);

    expect(history.canRedo).toBe(false);
    expect(history.popUndoToRedo()).toMatchObject({
      forwardEdits: [{ start: 1, end: 1, text: 'c' }],
    });
    expect(history.popUndoToRedo()).toMatchObject({
      forwardEdits: [{ start: 0, end: 0, text: 'a' }],
    });
  });

  test('clear resets both undo and redo stacks', () => {
    const history = new EditHistory();

    history.push('', [{ start: 0, end: 0, text: 'a' }], [caret(0)], undefined);
    history.popUndoToRedo();
    history.clear();

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.popUndoToRedo()).toBeUndefined();
    expect(history.popRedoToUndo()).toBeUndefined();
  });
});
