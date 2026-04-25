import { describe, expect, test } from 'bun:test';

import {
  type EditorSelection,
  SelectionDirection,
  toWebSelectionDirection,
} from '../src/editor/selection';
import {
  createTextareaSnippet,
  matchesTextareaState,
  resolveTextareaTextChange,
} from '../src/editor/textareaState';
import { TextDocument } from '../src/editor/textDocument';

type TextareaSnippetCase = {
  name: string;
  text: string;
  selection: EditorSelection;
  expected: {
    firstLine: number;
    lastLine: number;
    text: string;
    selectionStart: number;
    selectionEnd: number;
  };
};

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

const textareaSnippetCases: TextareaSnippetCase[] = [
  {
    name: 'includes only next context on the first line',
    text: 'alpha\nbeta',
    selection: createSelection(0, 0, 0, 0, SelectionDirection.None),
    expected: {
      firstLine: 0,
      lastLine: 1,
      text: 'alpha\nbeta',
      selectionStart: 0,
      selectionEnd: 0,
    },
  },
  {
    name: 'includes both surrounding context lines for a middle-line selection',
    text: 'alpha\nbravo\ncharlie\ndelta',
    selection: createSelection(1, 1, 1, 4, SelectionDirection.Forward),
    expected: {
      firstLine: 0,
      lastLine: 2,
      text: 'alpha\nbravo\ncharlie',
      selectionStart: 7,
      selectionEnd: 10,
    },
  },
  {
    name: 'clamps trailing context at the last line for multi-line selections',
    text: 'alpha\nbravo\ncharlie',
    selection: createSelection(1, 2, 2, 7, SelectionDirection.Forward),
    expected: {
      firstLine: 0,
      lastLine: 2,
      text: 'alpha\nbravo\ncharlie',
      selectionStart: 8,
      selectionEnd: 19,
    },
  },
  {
    name: 'preserves empty selected and context lines',
    text: 'top\n\nbottom\n',
    selection: createSelection(1, 0, 3, 0, SelectionDirection.Forward),
    expected: {
      firstLine: 0,
      lastLine: 3,
      text: 'top\n\nbottom\n',
      selectionStart: 4,
      selectionEnd: 12,
    },
  },
  {
    name: 'handles a single empty line selection',
    text: 'a\n\nc',
    selection: createSelection(1, 0, 1, 0, SelectionDirection.None),
    expected: {
      firstLine: 0,
      lastLine: 2,
      text: 'a\n\nc',
      selectionStart: 2,
      selectionEnd: 2,
    },
  },
];

function applyTextareaChange(
  text: string,
  selection: ReturnType<typeof createSelection>,
  value: string,
  selectionStart: number,
  selectionEnd = selectionStart,
  documentValue = text
) {
  const textDocument = new TextDocument('inmemory://1', text, 'plain');
  const snippet = createTextareaSnippet(textDocument, selection);
  const change = resolveTextareaTextChange({
    documentValue,
    originalValue: snippet.text,
    value,
    originalSelectionStart: snippet.selectionStart,
    originalSelectionEnd: snippet.selectionEnd,
    selectionStart,
    selectionEnd,
  });
  const snippetStartOffset = textDocument.offsetAt({
    line: snippet.firstLine,
    character: 0,
  });
  const start = textDocument.positionAt(snippetStartOffset + change.start);
  const end = textDocument.positionAt(snippetStartOffset + change.end);
  textDocument.applyEdits([
    {
      range: {
        start,
        end,
      },
      newText: change.text,
    },
  ]);
  return textDocument.getText();
}

describe('createTextareaSnippet', () => {
  for (const { name, text, selection, expected } of textareaSnippetCases) {
    test(name, () => {
      const textDocument = new TextDocument('inmemory://1', text, 'plain');
      expect(createTextareaSnippet(textDocument, selection)).toEqual(expected);
    });
  }
});

describe('resolveTextareaTextChange', () => {
  test('inserts a newline before an existing empty line', () => {
    const text = 'a\n\nb';
    const selection = createSelection(1, 0, 1, 0, SelectionDirection.None);

    expect(applyTextareaChange(text, selection, 'a\n\n\nb', 3)).toBe(
      'a\n\n\nb'
    );
  });

  test('deletes the nearest newline from consecutive empty lines', () => {
    const text = 'a\n\n\nb';
    const selection = createSelection(2, 0, 2, 0, SelectionDirection.None);

    expect(applyTextareaChange(text, selection, '\nb', 0)).toBe('a\n\nb');
  });

  test('keeps line indentation when inserting a newline', () => {
    const text = '  foo';
    const selection = createSelection(0, 5, 0, 5, SelectionDirection.None);

    expect(applyTextareaChange(text, selection, '  foo\n', 6)).toBe(
      '  foo\n  '
    );
  });

  test('backspace removes one document indent unit on a spaces-only line', () => {
    const text = '  alpha\n    \n  beta';
    const selection = createSelection(1, 4, 1, 4, SelectionDirection.None);

    expect(
      applyTextareaChange(text, selection, '  alpha\n   \n  beta', 11)
    ).toBe('  alpha\n  \n  beta');
  });

  test('backspace removes one document indent unit on a tabs-only line', () => {
    const text = '\talpha\n\t\t\n\tbeta';
    const selection = createSelection(1, 2, 1, 2, SelectionDirection.None);

    expect(applyTextareaChange(text, selection, '\talpha\n\t\n\tbeta', 8)).toBe(
      '\talpha\n\t\n\tbeta'
    );
  });

  test('backspace removes two spaces at a time from six-space line with wider nearby indent', () => {
    const text = '  root\n    alpha\n      \n    beta';
    const selection = createSelection(2, 6, 2, 6, SelectionDirection.None);

    expect(
      applyTextareaChange(
        text,
        selection,
        '    alpha\n     \n    beta',
        15,
        15,
        '  root\n  child\n    leaf'
      )
    ).toBe('  root\n    alpha\n    \n    beta');
  });

  test('backspace removes four spaces when document indent is four spaces', () => {
    const text = '    alpha\n        \n    beta';
    const selection = createSelection(1, 8, 1, 8, SelectionDirection.None);

    expect(
      applyTextareaChange(text, selection, '    alpha\n       \n    beta', 17)
    ).toBe('    alpha\n    \n    beta');
  });
});

describe('matchesTextareaState', () => {
  test('matches the textarea state produced for a rendered selection', () => {
    const textDocument = new TextDocument(
      'inmemory://1',
      'alpha\nbravo\ncharlie',
      'plain'
    );
    const selection = createSelection(1, 1, 1, 4, SelectionDirection.Forward);
    const snippet = createTextareaSnippet(textDocument, selection);

    expect(
      matchesTextareaState(
        {
          selections: [selection],
          primarySelection: selection,
          snippet,
          value: snippet.text,
        },
        {
          value: snippet.text,
          selectionStart: snippet.selectionStart,
          selectionEnd: snippet.selectionEnd,
          selectionDirection: toWebSelectionDirection(selection.direction),
        }
      )
    ).toBe(true);
  });

  test('returns false once the user changes the textarea selection', () => {
    const textDocument = new TextDocument(
      'inmemory://1',
      'alpha\nbravo\ncharlie',
      'plain'
    );
    const selection = createSelection(1, 1, 1, 4, SelectionDirection.Forward);
    const snippet = createTextareaSnippet(textDocument, selection);

    expect(
      matchesTextareaState(
        {
          selections: [selection],
          primarySelection: selection,
          snippet,
          value: snippet.text,
        },
        {
          value: snippet.text,
          selectionStart: snippet.selectionStart + 1,
          selectionEnd: snippet.selectionEnd + 1,
          selectionDirection: toWebSelectionDirection(selection.direction),
        }
      )
    ).toBe(false);
  });
});
