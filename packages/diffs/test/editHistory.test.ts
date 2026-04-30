import { describe, expect, test } from 'bun:test';

import { EditHistory } from '../src/editor/editHistory';
import type { EditorSelection } from '../src/editor/editorSelection';
import { SelectionDirection } from '../src/editor/editorSelection';

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

describe('EditHistory', () => {
  test('push stores cloned selections and pop methods move entries between stacks', () => {
    const history = new EditHistory();
    const selectionBefore = [caret(0), caret(1)];
    const selectionAfter = [caret(2), caret(3)];

    history.push(
      'ab',
      [{ start: 1, end: 1, text: 'X' }],
      4,
      5,
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
      versionBefore: 4,
      versionAfter: 5,
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
      1,
      2,
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

    history.push(
      '',
      [{ start: 0, end: 0, text: 'a' }],
      0,
      1,
      [caret(0)],
      undefined
    );
    history.push(
      'a',
      [{ start: 1, end: 1, text: 'b' }],
      1,
      2,
      [caret(1)],
      undefined
    );

    expect(history.popUndoToRedo()).toMatchObject({
      forwardEdits: [{ start: 1, end: 1, text: 'b' }],
    });
    expect(history.canRedo).toBe(true);

    history.push(
      'a',
      [{ start: 1, end: 1, text: 'c' }],
      1,
      2,
      [caret(1)],
      undefined
    );

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

    history.push(
      '',
      [{ start: 0, end: 0, text: 'a' }],
      0,
      1,
      [caret(0)],
      undefined
    );
    history.popUndoToRedo();
    history.clear();

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.popUndoToRedo()).toBeUndefined();
    expect(history.popRedoToUndo()).toBeUndefined();
  });
});
