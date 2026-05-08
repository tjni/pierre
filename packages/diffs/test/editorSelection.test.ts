import { describe, expect, test } from 'bun:test';

import {
  applyTextChangeToSelections,
  applyTextReplaceToSelections,
  convertSelection,
  DirectionForward,
  DirectionNone,
  type EditorSelection,
  extendSelections,
  mapSelectionMove,
  mapSelectionRangeMove,
  selectionIntersects,
} from '../src/editor/editorSelection';
import {
  DirectionBackward,
  type SelectionDirection,
} from '../src/editor/editorSelection';
import { TextDocument } from '../src/editor/textDocument';
import type { LineAnnotation } from '../src/types';

type MockNode = {
  nodeType: number;
  tagName?: string;
  parentElement?: MockElement | null;
  children?: MockElement[];
  childNodes?: MockNode[];
  textContent?: string | null;
};

type MockElement = MockNode & {
  tagName: string;
  parentElement?: MockElement | null;
  children: MockElement[];
  childNodes: MockNode[];
  dataset: Record<string, string>;
};

function composedRange(
  startContainer: Node,
  startOffset: number,
  endContainer = startContainer,
  endOffset = startOffset
): StaticRange {
  return {
    startContainer,
    startOffset,
    endContainer,
    endOffset,
    collapsed: startContainer === endContainer && startOffset === endOffset,
  } as StaticRange;
}

function editorSelection(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number
): EditorSelection {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
    direction: DirectionForward,
  };
}

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

function pre(line: number, children: MockElement[] = []): MockElement {
  const element: MockElement = {
    nodeType: 1,
    tagName: 'DIV',
    parentElement: null,
    children,
    childNodes: children,
    textContent: null,
    dataset: { lineIndex: String(line) },
  };
  for (const child of children) {
    child.parentElement = element;
  }
  return element;
}

function text(textContent: string): MockNode {
  return {
    nodeType: 3,
    textContent,
  };
}

function line(line: number, childNodes: MockNode[]): MockElement {
  const element = pre(
    line,
    childNodes.filter((child): child is MockElement => child.nodeType === 1)
  );
  element.childNodes = childNodes;
  element.textContent = childNodes
    .map((child) => child.textContent ?? '')
    .join('');
  for (const child of childNodes) {
    child.parentElement = element;
  }
  return element;
}

function br(): MockElement {
  return {
    nodeType: 1,
    tagName: 'BR',
    parentElement: null,
    children: [],
    childNodes: [],
    textContent: '',
    dataset: {},
  };
}

function span(text: string, char?: number): MockElement {
  const textNode: MockNode = {
    nodeType: 3,
    textContent: text,
  };
  const element: MockElement = {
    nodeType: 1,
    tagName: 'SPAN',
    parentElement: null,
    children: [],
    childNodes: [textNode],
    textContent: text,
    dataset: {},
  };
  textNode.parentElement = element;
  if (char !== undefined) {
    element.dataset.char = String(char);
  }
  return element;
}

function button(text: string): MockElement {
  const textNode: MockNode = {
    nodeType: 3,
    textContent: text,
  };
  const element: MockElement = {
    nodeType: 1,
    tagName: 'BUTTON',
    parentElement: null,
    children: [],
    childNodes: [textNode],
    textContent: text,
    dataset: {},
  };
  textNode.parentElement = element;
  return element;
}

function element(tagName: string, children: MockNode[] = []): MockElement {
  const el: MockElement = {
    nodeType: 1,
    tagName,
    parentElement: null,
    children: children.filter(
      (child): child is MockElement => child.nodeType === 1
    ),
    childNodes: children,
    textContent: children.map((child) => child.textContent ?? '').join(''),
    dataset: {},
  };
  for (const child of children) {
    child.parentElement = el;
  }
  return el;
}

describe('convertSelection', () => {
  test('maps a caret on an empty rendered line to character zero', () => {
    const line = pre(1, [br()]);
    expect(convertSelection(composedRange(line as unknown as Node, 0))).toEqual(
      {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 0 },
        direction: DirectionNone,
      }
    );
  });

  test('treats a placeholder br boundary as the start of the line', () => {
    const line = pre(2, [br()]);
    expect(convertSelection(composedRange(line as unknown as Node, 1))).toEqual(
      {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 0 },
        direction: DirectionNone,
      }
    );
  });

  test('ignores the line number gutter span on an empty line', () => {
    const line = pre(3, [span('4'), br()]);
    expect(convertSelection(composedRange(line as unknown as Node, 1))).toEqual(
      {
        start: { line: 3, character: 0 },
        end: { line: 3, character: 0 },
        direction: DirectionNone,
      }
    );
    expect(convertSelection(composedRange(line as unknown as Node, 2))).toEqual(
      {
        start: { line: 3, character: 0 },
        end: { line: 3, character: 0 },
        direction: DirectionNone,
      }
    );
  });

  test('ignores the fold toggle button in the gutter', () => {
    const line = pre(4, [span('5'), button('>'), span('color', 0)]);
    expect(convertSelection(composedRange(line as unknown as Node, 2))).toEqual(
      {
        start: { line: 4, character: 0 },
        end: { line: 4, character: 0 },
        direction: DirectionNone,
      }
    );
  });

  test('maps a direct line text node to its character offset', () => {
    const textNode = text('abcdef');
    line(6, [textNode]);
    expect(
      convertSelection(composedRange(textNode as unknown as Node, 2))
    ).toEqual({
      start: { line: 6, character: 2 },
      end: { line: 6, character: 2 },
      direction: DirectionNone,
    });
  });

  test('maps a span text node from its data-char base', () => {
    const token = span('abcdef', 10);
    const textNode = token.childNodes[0];
    pre(7, [token]);
    expect(
      convertSelection(composedRange(textNode as unknown as Node, 3))
    ).toEqual({
      start: { line: 7, character: 13 },
      end: { line: 7, character: 13 },
      direction: DirectionNone,
    });
  });

  test('ignores newline placeholders in direct line text nodes', () => {
    const textNode = text('\n');
    line(8, [textNode]);
    expect(
      convertSelection(composedRange(textNode as unknown as Node, 1))
    ).toEqual({
      start: { line: 8, character: 0 },
      end: { line: 8, character: 0 },
      direction: DirectionNone,
    });
  });

  test('maps clicks inside a fold button on an empty line to character zero', () => {
    const icon = element('SVG', [element('POLYLINE')]);
    const toggle = element('BUTTON', [icon]);
    pre(5, [span('6'), toggle, br()]);
    expect(
      convertSelection(composedRange(toggle as unknown as Node, 0))
    ).toEqual({
      start: { line: 5, character: 0 },
      end: { line: 5, character: 0 },
      direction: DirectionNone,
    });
    expect(convertSelection(composedRange(icon as unknown as Node, 0))).toEqual(
      {
        start: { line: 5, character: 0 },
        end: { line: 5, character: 0 },
        direction: DirectionNone,
      }
    );
  });
});

describe('selectionIntersects', () => {
  test('detects overlapping ranges on the same line', () => {
    expect(
      selectionIntersects(
        editorSelection(0, 2, 0, 6),
        editorSelection(0, 4, 0, 8)
      )
    ).toBe(true);
  });

  test('detects overlapping ranges across lines', () => {
    expect(
      selectionIntersects(
        editorSelection(0, 2, 2, 3),
        editorSelection(1, 0, 3, 1)
      )
    ).toBe(true);
  });

  test('does not treat adjacent range boundaries as intersections', () => {
    expect(
      selectionIntersects(
        editorSelection(0, 2, 0, 6),
        editorSelection(0, 6, 0, 8)
      )
    ).toBe(false);
  });

  test('does not intersect separated ranges', () => {
    expect(
      selectionIntersects(
        editorSelection(0, 2, 0, 4),
        editorSelection(1, 0, 1, 2)
      )
    ).toBe(false);
  });

  test('treats a caret inside a range as an intersection', () => {
    expect(
      selectionIntersects(
        editorSelection(0, 2, 0, 6),
        editorSelection(0, 4, 0, 4)
      )
    ).toBe(true);
  });

  test('treats a caret on a range boundary as an intersection', () => {
    expect(
      selectionIntersects(
        editorSelection(0, 2, 0, 6),
        editorSelection(0, 6, 0, 6)
      )
    ).toBe(true);
  });

  test('matches collapsed selections only at the same position', () => {
    expect(
      selectionIntersects(
        editorSelection(0, 2, 0, 2),
        editorSelection(0, 2, 0, 2)
      )
    ).toBe(true);
    expect(
      selectionIntersects(
        editorSelection(0, 2, 0, 2),
        editorSelection(0, 3, 0, 3)
      )
    ).toBe(false);
  });
});

describe('applyTextChangeToSelections', () => {
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
      createSelection(0, 0, 0, 3, DirectionForward),
      createSelection(0, 4, 0, 7, DirectionForward),
      createSelection(0, 8, 0, 11, DirectionForward),
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

  test('copies leading indentation onto the new line after Enter', () => {
    const textDocument = new TextDocument('inmemory://1', '  foo\nbar');
    const selections = [createSelection(0, 5, 0, 5)];
    const { nextSelections } = applyTextChangeToSelections(
      textDocument,
      selections,
      {
        start: 5,
        end: 5,
        text: '\n',
      }
    );

    expect(textDocument.getText()).toBe('  foo\n  \nbar');
    expect(nextSelections).toEqual([createSelection(1, 2, 1, 2)]);
  });

  test("uses each line's indent when inserting a newline at multiple carets", () => {
    const textDocument = new TextDocument('inmemory://1', '  a\n\tb');
    const selections = [
      createSelection(0, 3, 0, 3),
      createSelection(1, 2, 1, 2),
    ];
    const { nextSelections } = applyTextChangeToSelections(
      textDocument,
      selections,
      {
        start: 6,
        end: 6,
        text: '\n',
      }
    );

    expect(textDocument.getText()).toBe('  a\n  \n\tb\n\t');
    expect(nextSelections).toEqual([
      createSelection(1, 2, 1, 2),
      createSelection(3, 1, 3, 1),
    ]);
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

  test('deletes one hard tab when backspacing in leading indentation', () => {
    const textDocument = new TextDocument('inmemory://1', '\tfoo');
    const selections = [createSelection(0, 1, 0, 1)];
    const { nextSelections } = applyTextChangeToSelections(
      textDocument,
      selections,
      {
        start: 0,
        end: 1,
        text: '',
      },
      undefined,
      2
    );

    expect(textDocument.getText()).toBe('foo');
    expect(nextSelections).toEqual([createSelection(0, 0, 0, 0)]);
  });

  test('deletes one soft tab when backspacing in leading indentation', () => {
    const textDocument = new TextDocument('inmemory://1', '    foo');
    const selections = [createSelection(0, 4, 0, 4)];
    const { nextSelections } = applyTextChangeToSelections(
      textDocument,
      selections,
      {
        start: 3,
        end: 4,
        text: '',
      },
      undefined,
      4
    );

    expect(textDocument.getText()).toBe('foo');
    expect(nextSelections).toEqual([createSelection(0, 0, 0, 0)]);
  });

  test('does not expand deletion outside leading indentation', () => {
    const textDocument = new TextDocument('inmemory://1', '  foo');
    const selections = [createSelection(0, 3, 0, 3)];
    const { nextSelections } = applyTextChangeToSelections(
      textDocument,
      selections,
      {
        start: 2,
        end: 3,
        text: '',
      },
      undefined,
      2
    );

    expect(textDocument.getText()).toBe('  oo');
    expect(nextSelections).toEqual([createSelection(0, 2, 0, 2)]);
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
      createSelection(0, 1, 0, 2, DirectionForward),
      createSelection(1, 1, 1, 2, DirectionForward),
    ];

    expect(
      mapSelectionMove(textDocument, selections, { line: 1, character: 1 })
    ).toEqual([
      createSelection(0, 1, 0, 1, DirectionNone),
      createSelection(1, 1, 1, 1, DirectionNone),
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
      createSelection(0, 1, 0, 3, DirectionForward),
      createSelection(1, 1, 1, 3, DirectionForward),
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
      createSelection(0, 0, 0, 2, DirectionBackward),
      createSelection(1, 0, 1, 2, DirectionBackward),
    ]);
  });
});

describe('applyTextReplaceToSelections', () => {
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

describe('computeExtendSelection', () => {
  test('returns undefined for empty selections', () => {
    const doc = new TextDocument('inmemory://x', 'hello');
    expect(extendSelections(doc, [])).toBeUndefined();
  });

  test('ignores non-collapsed selections with different text', () => {
    const doc = new TextDocument('inmemory://x', 'aa bb');
    const selections: EditorSelection[] = [
      createSelection(0, 0, 0, 2),
      createSelection(0, 3, 0, 5),
    ];
    expect(extendSelections(doc, selections)).toBeUndefined();
  });

  test('expands a collapsed caret to the surrounding word', () => {
    const doc = new TextDocument('inmemory://x', "'foobar'");
    const caret = createSelection(0, 4, 0, 4);
    const next = extendSelections(doc, [caret]);
    expect(next).toEqual([
      {
        start: { line: 0, character: 1 },
        end: { line: 0, character: 7 },
        direction: DirectionForward,
      },
    ]);
  });

  test('adds the next matching range when one occurrence is selected', () => {
    const doc = new TextDocument('inmemory://x', 'foo x foo');
    const first = createSelection(0, 0, 0, 3);
    const afterFirst = extendSelections(doc, [first]);
    expect(afterFirst).toEqual([
      first,
      {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 9 },
        direction: DirectionForward,
      },
    ]);
    expect(extendSelections(doc, afterFirst!)).toBeUndefined();
  });

  test('wraps to an earlier occurrence after the last match in the file', () => {
    const doc = new TextDocument('inmemory://x', 'foo bar foo');
    const secondFoo = createSelection(0, 8, 0, 11);
    const wrapped = extendSelections(doc, [secondFoo]);
    expect(wrapped).toEqual([
      secondFoo,
      {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
        direction: DirectionForward,
      },
    ]);
  });

  test('allows multiple selections when every range has the same text', () => {
    const doc = new TextDocument('inmemory://x', 'ab ab ab');
    const a = createSelection(0, 0, 0, 2);
    const b = createSelection(0, 3, 0, 5);
    const two = [a, b];
    const third = extendSelections(doc, two);
    expect(third?.length).toBe(3);
    expect(third?.[2]).toEqual({
      start: { line: 0, character: 6 },
      end: { line: 0, character: 8 },
      direction: DirectionForward,
    });
  });
});
