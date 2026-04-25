import { describe, expect, test } from 'bun:test';

import { convertSelection, SelectionDirection } from '../src/editor/selection';

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
};

function selection(
  anchorNode: Node,
  anchorOffset: number,
  focusNode: Node,
  focusOffset: number
): Selection {
  return {
    rangeCount: 1,
    anchorNode,
    anchorOffset,
    focusNode,
    focusOffset,
  } as Selection;
}

function pre(line: number, children: MockElement[] = []): MockElement {
  const element: MockElement = {
    nodeType: 1,
    tagName: 'PRE',
    parentElement: null,
    children,
    childNodes: children,
    textContent: null,
  };
  Reflect.set(element, 'LINE', line);
  for (const child of children) {
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
  };
  textNode.parentElement = element;
  if (char !== undefined) {
    Reflect.set(element, 'CHAR', char);
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
  };
  for (const child of children) {
    child.parentElement = el;
  }
  return el;
}

describe('convertSelection', () => {
  test('maps a caret on an empty rendered line to character zero', () => {
    const line = pre(1, [br()]);
    expect(
      convertSelection(
        selection(line as unknown as Node, 0, line as unknown as Node, 0)
      )
    ).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 0 },
      direction: SelectionDirection.None,
    });
  });

  test('treats a placeholder br boundary as the start of the line', () => {
    const line = pre(2, [br()]);
    expect(
      convertSelection(
        selection(line as unknown as Node, 1, line as unknown as Node, 1)
      )
    ).toEqual({
      start: { line: 2, character: 0 },
      end: { line: 2, character: 0 },
      direction: SelectionDirection.None,
    });
  });

  test('ignores the line number gutter span on an empty line', () => {
    const line = pre(3, [span('4'), br()]);
    expect(
      convertSelection(
        selection(line as unknown as Node, 1, line as unknown as Node, 1)
      )
    ).toEqual({
      start: { line: 3, character: 0 },
      end: { line: 3, character: 0 },
      direction: SelectionDirection.None,
    });
    expect(
      convertSelection(
        selection(line as unknown as Node, 2, line as unknown as Node, 2)
      )
    ).toEqual({
      start: { line: 3, character: 0 },
      end: { line: 3, character: 0 },
      direction: SelectionDirection.None,
    });
  });

  test('ignores the fold toggle button in the gutter', () => {
    const line = pre(4, [span('5'), button('>'), span('color', 0)]);
    expect(
      convertSelection(
        selection(line as unknown as Node, 2, line as unknown as Node, 2)
      )
    ).toEqual({
      start: { line: 4, character: 0 },
      end: { line: 4, character: 0 },
      direction: SelectionDirection.None,
    });
  });

  test('maps clicks inside a fold button on an empty line to character zero', () => {
    const icon = element('SVG', [element('POLYLINE')]);
    const toggle = element('BUTTON', [icon]);
    pre(5, [span('6'), toggle, br()]);
    expect(
      convertSelection(
        selection(toggle as unknown as Node, 0, toggle as unknown as Node, 0)
      )
    ).toEqual({
      start: { line: 5, character: 0 },
      end: { line: 5, character: 0 },
      direction: SelectionDirection.None,
    });
    expect(
      convertSelection(
        selection(icon as unknown as Node, 0, icon as unknown as Node, 0)
      )
    ).toEqual({
      start: { line: 5, character: 0 },
      end: { line: 5, character: 0 },
      direction: SelectionDirection.None,
    });
  });
});
