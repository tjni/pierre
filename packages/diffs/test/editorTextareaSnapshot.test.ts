import { describe, expect, test } from 'bun:test';

import {
  type EditorSelection,
  SelectionDirection,
} from '../src/editor/editorSelection';
import {
  createTextareaSnapshot,
  resolveTextChange,
} from '../src/editor/editorTextareaSnapshot';
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

    expect(resolveTextChange(snippet, '1')).toEqual({
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

    expect(resolveTextChange(snippet, 'ac')).toEqual({
      start: 1,
      end: 2,
      text: '',
    });
  });
});
