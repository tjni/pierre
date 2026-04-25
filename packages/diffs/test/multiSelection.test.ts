import { describe, expect, test } from 'bun:test';

import {
  mapSelectionMove,
  mapSelectionTextChange,
  mapSelectionTextReplace,
} from '../src/editor/multiSelection';
import type { EditorSelection } from '../src/editor/selection';
import { SelectionDirection } from '../src/editor/selection';
import { TextDocument } from '../src/editor/textDocument';

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

describe('mapSelectionTextChange', () => {
  test('inserts the same text at multiple carets', () => {
    const textDocument = new TextDocument('inmemory://1', 'a\nb\nc');
    const selections = [
      createSelection(0, 1, 0, 1),
      createSelection(1, 1, 1, 1),
      createSelection(2, 1, 2, 1),
    ];
    const { edits, nextSelections } = mapSelectionTextChange(
      textDocument,
      selections,
      {
        start: 5,
        end: 5,
        text: '!',
        selectionStart: 6,
        selectionEnd: 6,
        direction: SelectionDirection.None,
      }
    );

    textDocument.applyEdits(edits);

    expect(textDocument.getText()).toBe('a!\nb!\nc!');
    expect(nextSelections).toEqual([
      createSelection(0, 2, 0, 2),
      createSelection(1, 2, 1, 2),
      createSelection(2, 2, 2, 2),
    ]);
  });

  test('replaces each selected range with the typed text', () => {
    const textDocument = new TextDocument('inmemory://1', 'foo bar baz');
    const selections = [
      createSelection(0, 0, 0, 3, SelectionDirection.Forward),
      createSelection(0, 4, 0, 7, SelectionDirection.Forward),
      createSelection(0, 8, 0, 11, SelectionDirection.Forward),
    ];
    const { edits, nextSelections } = mapSelectionTextChange(
      textDocument,
      selections,
      {
        start: 8,
        end: 11,
        text: 'x',
        selectionStart: 9,
        selectionEnd: 9,
        direction: SelectionDirection.None,
      }
    );

    textDocument.applyEdits(edits);

    expect(textDocument.getText()).toBe('x x x');
    expect(nextSelections).toEqual([
      createSelection(0, 1, 0, 1),
      createSelection(0, 3, 0, 3),
      createSelection(0, 5, 0, 5),
    ]);
  });

  test('mirrors backspace for multiple carets', () => {
    const textDocument = new TextDocument('inmemory://1', 'ax\nbx\ncx');
    const selections = [
      createSelection(0, 1, 0, 1),
      createSelection(1, 1, 1, 1),
      createSelection(2, 1, 2, 1),
    ];
    const { edits, nextSelections } = mapSelectionTextChange(
      textDocument,
      selections,
      {
        start: 6,
        end: 7,
        text: '',
        selectionStart: 6,
        selectionEnd: 6,
        direction: SelectionDirection.None,
      }
    );

    textDocument.applyEdits(edits);

    expect(textDocument.getText()).toBe('x\nx\nx');
    expect(nextSelections).toEqual([
      createSelection(0, 0, 0, 0),
      createSelection(1, 0, 1, 0),
      createSelection(2, 0, 2, 0),
    ]);
  });

  test('coalesces transformed edits that would overlap', () => {
    const textDocument = new TextDocument('inmemory://1', '    ');
    const selections = [
      createSelection(0, 1, 0, 1),
      createSelection(0, 2, 0, 2),
    ];
    const { edits, nextSelections } = mapSelectionTextChange(
      textDocument,
      selections,
      {
        start: 0,
        end: 2,
        text: '',
        selectionStart: 0,
        selectionEnd: 0,
        direction: SelectionDirection.None,
      }
    );

    textDocument.applyEdits(edits);

    expect(textDocument.getText()).toBe('  ');
    expect(nextSelections).toEqual([
      createSelection(0, 0, 0, 0),
      createSelection(0, 0, 0, 0),
    ]);
  });
});

describe('mapSelectionMove', () => {
  test('moves all carets when the primary caret moves', () => {
    const textDocument = new TextDocument('inmemory://1', 'ab\ncd\nef');
    const selections = [
      createSelection(0, 1, 0, 1),
      createSelection(1, 1, 1, 1),
      createSelection(2, 1, 2, 1),
    ];

    expect(
      mapSelectionMove(textDocument, selections, { line: 2, character: 0 })
    ).toEqual([
      createSelection(0, 0, 0, 0),
      createSelection(1, 0, 1, 0),
      createSelection(2, 0, 2, 0),
    ]);
  });

  test('extends all selections when the primary selection grows', () => {
    const textDocument = new TextDocument('inmemory://1', 'abcd\nefgh');
    const selections = [
      createSelection(0, 1, 0, 2, SelectionDirection.Forward),
      createSelection(1, 1, 1, 2, SelectionDirection.Forward),
    ];

    expect(
      mapSelectionMove(textDocument, selections, { line: 1, character: 1 })
    ).toEqual([
      createSelection(0, 1, 0, 1, SelectionDirection.None),
      createSelection(1, 1, 1, 1, SelectionDirection.None),
    ]);
  });
});

describe('mapSelectionTextReplace', () => {
  test('replaces each selection with its own pasted text', () => {
    const textDocument = new TextDocument('inmemory://1', 'x\ny\nz');
    const selections = [
      createSelection(0, 1, 0, 1),
      createSelection(1, 1, 1, 1),
      createSelection(2, 1, 2, 1),
    ];
    const { edits, nextSelections } = mapSelectionTextReplace(
      textDocument,
      selections,
      ['a', 'b', 'c']
    );

    textDocument.applyEdits(edits);

    expect(textDocument.getText()).toBe('xa\nyb\nzc');
    expect(nextSelections).toEqual([
      createSelection(0, 2, 0, 2),
      createSelection(1, 2, 1, 2),
      createSelection(2, 2, 2, 2),
    ]);
  });
});
