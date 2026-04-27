import { describe, expect, test } from 'bun:test';

import {
  convertSelection,
  type EditorSelection,
  SelectionDirection,
  selectionIntersects,
} from '../src/editor/editorSelection';

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
): StaticRange[] {
  return [
    {
      startContainer,
      startOffset,
      endContainer,
      endOffset,
      collapsed: startContainer === endContainer && startOffset === endOffset,
    } as StaticRange,
  ];
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
    direction: SelectionDirection.Forward,
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
        direction: SelectionDirection.None,
      }
    );
  });

  test('treats a placeholder br boundary as the start of the line', () => {
    const line = pre(2, [br()]);
    expect(convertSelection(composedRange(line as unknown as Node, 1))).toEqual(
      {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 0 },
        direction: SelectionDirection.None,
      }
    );
  });

  test('ignores the line number gutter span on an empty line', () => {
    const line = pre(3, [span('4'), br()]);
    expect(convertSelection(composedRange(line as unknown as Node, 1))).toEqual(
      {
        start: { line: 3, character: 0 },
        end: { line: 3, character: 0 },
        direction: SelectionDirection.None,
      }
    );
    expect(convertSelection(composedRange(line as unknown as Node, 2))).toEqual(
      {
        start: { line: 3, character: 0 },
        end: { line: 3, character: 0 },
        direction: SelectionDirection.None,
      }
    );
  });

  test('ignores the fold toggle button in the gutter', () => {
    const line = pre(4, [span('5'), button('>'), span('color', 0)]);
    expect(convertSelection(composedRange(line as unknown as Node, 2))).toEqual(
      {
        start: { line: 4, character: 0 },
        end: { line: 4, character: 0 },
        direction: SelectionDirection.None,
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
      direction: SelectionDirection.None,
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
      direction: SelectionDirection.None,
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
      direction: SelectionDirection.None,
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
      direction: SelectionDirection.None,
    });
    expect(convertSelection(composedRange(icon as unknown as Node, 0))).toEqual(
      {
        start: { line: 5, character: 0 },
        end: { line: 5, character: 0 },
        direction: SelectionDirection.None,
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
