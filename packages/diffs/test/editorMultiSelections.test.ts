import { describe, expect, test } from 'bun:test';

import {
  applyTextChangeToSelections,
  applyTextReplaceToSelections,
  mapSelectionMove,
  mapSelectionRangeMove,
} from '../src/editor/editorMultiSelections';
import type { EditorSelection } from '../src/editor/editorSelection';
import { SelectionDirection } from '../src/editor/editorSelection';
import { TextDocument } from '../src/editor/textDocument';
import type { LineAnnotation } from '../src/types';

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
    const { nextSelections } = applyTextChangeToSelections(
      textDocument,
      selections,
      {
        start: 5,
        end: 5,
        text: '!',
      }
    );

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
    const { nextSelections } = applyTextChangeToSelections(
      textDocument,
      selections,
      {
        start: 8,
        end: 11,
        text: 'x',
      }
    );

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
    const { nextSelections } = applyTextChangeToSelections(
      textDocument,
      selections,
      {
        start: 6,
        end: 7,
        text: '',
      }
    );

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
    const { nextSelections } = applyTextChangeToSelections(
      textDocument,
      selections,
      {
        start: 0,
        end: 2,
        text: '',
      }
    );

    expect(textDocument.getText()).toBe('  ');
    expect(nextSelections).toEqual([
      createSelection(0, 0, 0, 0),
      createSelection(0, 0, 0, 0),
    ]);
  });

  test('places the caret on the inserted blank line after Enter', () => {
    const textDocument = new TextDocument('inmemory://1', 'foo\nbar');
    const selections = [createSelection(0, 3, 0, 3)];
    const { nextSelections } = applyTextChangeToSelections(
      textDocument,
      selections,
      {
        start: 3,
        end: 3,
        text: '\n',
      }
    );

    expect(textDocument.getText()).toBe('foo\n\nbar');
    expect(nextSelections).toEqual([createSelection(1, 0, 1, 0)]);
  });

  test('moves the caret to the previous line end after deleting a line break', () => {
    const textDocument = new TextDocument('inmemory://1', 'foo\n\nbar');
    const selections = [createSelection(1, 0, 1, 0)];
    const { nextSelections } = applyTextChangeToSelections(
      textDocument,
      selections,
      {
        start: 3,
        end: 4,
        text: '',
      }
    );

    expect(textDocument.getText()).toBe('foo\nbar');
    expect(nextSelections).toEqual([createSelection(0, 3, 0, 3)]);
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

describe('mapSelectionRangeMove', () => {
  test('extends all carets when the primary textarea selection becomes a range', () => {
    const textDocument = new TextDocument('inmemory://1', 'abcd\nefgh');
    const selections = [
      createSelection(0, 1, 0, 1),
      createSelection(1, 1, 1, 1),
    ];

    expect(
      mapSelectionRangeMove(
        textDocument,
        selections,
        { line: 1, character: 1 },
        { line: 1, character: 3 }
      )
    ).toEqual([
      createSelection(0, 1, 0, 3, SelectionDirection.Forward),
      createSelection(1, 1, 1, 3, SelectionDirection.Forward),
    ]);
  });

  test('preserves backward selection direction from the textarea focus', () => {
    const textDocument = new TextDocument('inmemory://1', 'abcd\nefgh');
    const selections = [
      createSelection(0, 2, 0, 2),
      createSelection(1, 2, 1, 2),
    ];

    expect(
      mapSelectionRangeMove(
        textDocument,
        selections,
        { line: 1, character: 2 },
        { line: 1, character: 0 }
      )
    ).toEqual([
      createSelection(0, 0, 0, 2, SelectionDirection.Backward),
      createSelection(1, 0, 1, 2, SelectionDirection.Backward),
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
    const { nextSelections } = applyTextReplaceToSelections(
      textDocument,
      selections,
      ['a', 'b', 'c']
    );

    expect(textDocument.getText()).toBe('xa\nyb\nzc');
    expect(nextSelections).toEqual([
      createSelection(0, 2, 0, 2),
      createSelection(1, 2, 1, 2),
      createSelection(2, 2, 2, 2),
    ]);
  });

  test('updates line annotations after replacements that insert lines', () => {
    const textDocument = new TextDocument('inmemory://1', 'x\ny\nz');
    const selections = [createSelection(0, 1, 0, 1)];
    const annotations: LineAnnotation<string>[] = [
      { lineNumber: 1, metadata: 'x' },
      { lineNumber: 2, metadata: 'y' },
    ];

    const { newLineAnnotations } = applyTextReplaceToSelections(
      textDocument,
      selections,
      ['\ninserted'],
      annotations
    );

    expect(textDocument.getText()).toBe('x\ninserted\ny\nz');
    expect(newLineAnnotations).toEqual([
      { lineNumber: 1, metadata: 'x' },
      { lineNumber: 3, metadata: 'y' },
    ]);
    expect(textDocument.undo()).toEqual({
      selections,
      lineAnnotations: annotations,
    });
    expect(textDocument.redo()).toEqual({
      selections: [createSelection(1, 8, 1, 8)],
      lineAnnotations: newLineAnnotations,
    });
  });
});
