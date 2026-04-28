import { describe, expect, test } from 'bun:test';

import {
  type EditorSelection,
  SelectionDirection,
} from '../src/editor/editorSelection';
import {
  createTextareaSnapshot,
  resolveTextareaChange,
} from '../src/editor/editorTextarea';
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

describe('resolveTextChange', () => {
  test('replaces selected text with a shorter typed value', () => {
    const textDocument = new TextDocument('inmemory://1', 'abc');
    const snippet = createTextareaSnapshot(
      textDocument,
      createSelection(0, 0, 0, 3, SelectionDirection.Forward)
    );

    expect(resolveTextareaChange(snippet, '1')).toEqual({
      start: 0,
      end: 3,
      text: '1',
    });
  });

  test('keeps pure deletion as an empty replacement', () => {
    const textDocument = new TextDocument('inmemory://1', 'abc');
    const snippet = createTextareaSnapshot(
      textDocument,
      createSelection(0, 2, 0, 2)
    );

    expect(resolveTextareaChange(snippet, 'ac')).toEqual({
      start: 1,
      end: 2,
      text: '',
    });
  });

  test('uses the caret to resolve Enter before an existing line break', () => {
    const textDocument = new TextDocument('inmemory://1', 'foo\nbar');
    const snippet = createTextareaSnapshot(
      textDocument,
      createSelection(0, 3, 0, 3)
    );

    expect(resolveTextareaChange(snippet, 'foo\n\nbar', 4, 4)).toEqual({
      start: 3,
      end: 3,
      text: '\n',
    });
  });

  test('uses the caret to resolve Backspace at an empty line start', () => {
    const textDocument = new TextDocument('inmemory://1', 'foo\n\nbar');
    const snippet = createTextareaSnapshot(
      textDocument,
      createSelection(1, 0, 1, 0)
    );

    expect(resolveTextareaChange(snippet, 'foo\nbar', 3, 3)).toEqual({
      start: 3,
      end: 4,
      text: '',
    });
  });
});
