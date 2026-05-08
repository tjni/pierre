import { describe, expect, test } from 'bun:test';

import {
  DirectionNone,
  type EditorSelection,
  type SelectionDirection,
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
  direction: SelectionDirection = DirectionNone
): EditorSelection {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
    direction,
  };
}

describe('resolveTextChange', () => {
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

  test('keeps the textarea selection range when neighbour characters match the diff', () => {
    const line0 = '    "a": "catalog:",';
    const line1 = '    "b": "catalog:",';
    const line2 = '    "c": "catalog:",';
    const textDocument = new TextDocument(
      'inmemory://1',
      [line0, line1, line2].join('\n')
    );
    const snippet = createTextareaSnapshot(
      textDocument,
      createSelection(1, 4, 1, 38, DirectionNone)
    );

    const deleted =
      snippet.text.slice(0, snippet.selectionStart) +
      snippet.text.slice(snippet.selectionEnd);

    expect(
      resolveTextareaChange(
        snippet,
        deleted,
        snippet.selectionStart,
        snippet.selectionStart
      )
    ).toEqual({
      start: snippet.offset + snippet.selectionStart,
      end: snippet.offset + snippet.selectionEnd,
      text: '',
    });
  });

  test('clamps caret column on empty lines so textarea slice matches the document', () => {
    const textDocument = new TextDocument('inmemory://1', 'a\n\nb');
    const valid = createTextareaSnapshot(
      textDocument,
      createSelection(1, 0, 1, 0)
    );
    const oversizedColumnFromDomPlaceholder = createTextareaSnapshot(
      textDocument,
      createSelection(1, 1, 1, 1)
    );

    expect(oversizedColumnFromDomPlaceholder.selectionStart).toBe(
      valid.selectionStart
    );
    expect(oversizedColumnFromDomPlaceholder.selectionEnd).toBe(
      valid.selectionEnd
    );
    expect(oversizedColumnFromDomPlaceholder.text).toBe(valid.text);
    expect(oversizedColumnFromDomPlaceholder.offset).toBe(valid.offset);
  });
});
