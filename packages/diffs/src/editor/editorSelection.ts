import { getLineIndentationUnit } from './editorUtils';
import type { Position, Range, TextDocument, TextEdit } from './textDocument';

export enum SelectionDirection {
  Backward = -1,
  None = 0,
  Forward = 1,
}

export type EditorSelection = Range & {
  direction: SelectionDirection;
};

export type EditorTextChange = {
  start: number;
  end: number;
  text: string;
};

/**
 * Converts a selection from a web selection to an editor selection.
 * @param selection - The web selection to convert.
 * @returns The converted editor selection.
 */
export function convertSelection({
  rangeCount,
  anchorNode,
  focusNode,
  anchorOffset,
  focusOffset,
}: Selection): EditorSelection | null {
  if (rangeCount === 0 || anchorNode === null || focusNode === null) {
    return null;
  }
  const anchor = boundaryToPosition(anchorNode, anchorOffset);
  const focus = boundaryToPosition(focusNode, focusOffset);
  if (anchor === null || focus === null) {
    return null;
  }
  const order = comparePosition(anchor, focus);
  const direction =
    order === 0
      ? SelectionDirection.None
      : order < 0
        ? SelectionDirection.Forward
        : SelectionDirection.Backward;
  const start = direction === SelectionDirection.Forward ? anchor : focus;
  const end = direction === SelectionDirection.Forward ? focus : anchor;
  return {
    start,
    end,
    direction,
  };
}

export function resolveIndentEdits(
  textDocument: TextDocument,
  selection: EditorSelection,
  tabSize: number,
  outdent: boolean
): [edits: TextEdit[], nextSelection: EditorSelection] {
  if (textDocument === undefined) {
    return [[], selection];
  }
  const { start, end } = selection;
  let endLine = end.line;
  if (start.line < end.line && end.character === 0) {
    endLine--;
  }
  const edits: TextEdit[] = [];
  const newSelection: EditorSelection = { ...selection };
  for (let line = start.line; line <= endLine; line++) {
    const lineText = textDocument.getLineText(line);
    if (lineText === undefined) {
      continue;
    }
    const indentUnit = getLineIndentationUnit(lineText, tabSize);
    let deleteLength = 0;
    let newText = indentUnit;
    if (outdent) {
      if (lineText.startsWith('\t')) {
        deleteLength = 1;
      } else if (lineText.startsWith(' ')) {
        const leadingSpacesLength =
          lineText.length - lineText.trimStart().length;
        deleteLength = Math.min(indentUnit.length, leadingSpacesLength);
      }
      if (deleteLength === 0) {
        continue;
      }
      newText = '';
    }
    edits.push({
      range: {
        start: { line, character: 0 },
        end: { line, character: deleteLength },
      },
      newText,
    });
    const delte = newText.length - deleteLength;
    if (line === start.line) {
      newSelection.start = {
        ...start,
        character: Math.max(0, start.character + delte),
      };
    }
    if (line === end.line) {
      newSelection.end = {
        ...end,
        character: Math.max(0, end.character + delte),
      };
    }
  }
  return [edits, newSelection];
}

export function isCollapsedSelection(selection: EditorSelection): boolean {
  return (
    selection.start.line === selection.end.line &&
    selection.start.character === selection.end.character
  );
}

export function selectionIntersects(
  a: EditorSelection,
  b: EditorSelection
): boolean {
  const aCollapsed = isCollapsedSelection(a);
  const bCollapsed = isCollapsedSelection(b);
  if (aCollapsed && bCollapsed) {
    return comparePosition(a.start, b.start) === 0;
  }
  if (aCollapsed) {
    return (
      comparePosition(b.start, a.start) <= 0 &&
      comparePosition(a.start, b.end) <= 0
    );
  }
  if (bCollapsed) {
    return (
      comparePosition(a.start, b.start) <= 0 &&
      comparePosition(b.start, a.end) <= 0
    );
  }
  return (
    comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0
  );
}

export function getPrimarySelection(
  selections: readonly EditorSelection[]
): EditorSelection | undefined {
  const selection = selections[selections.length - 1];
  return selection !== undefined ? { ...selection } : undefined;
}

export function toWebSelectionDirection(
  direction: SelectionDirection
): 'none' | 'forward' | 'backward' {
  return direction === SelectionDirection.None
    ? 'none'
    : direction === SelectionDirection.Forward
      ? 'forward'
      : 'backward';
}

export function fromWebSelectionDirection(
  direction: 'none' | 'forward' | 'backward'
): SelectionDirection {
  return direction === 'none'
    ? SelectionDirection.None
    : direction === 'forward'
      ? SelectionDirection.Forward
      : SelectionDirection.Backward;
}

export function comparePosition(a: Position, b: Position): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.character - b.character;
}

function boundaryToPosition(node: Node, offset: number): Position | null {
  if (node.nodeType === 3) {
    const parent = node.parentElement;
    if (parent === null) {
      return null;
    }
    if (parent.tagName === 'SPAN') {
      const pre = parent.parentElement;
      if (pre === null || pre.tagName !== 'PRE') {
        return null;
      }
      const line = getLineProp(pre);
      const base = getCharacterProp(parent);
      if (line !== undefined && base !== undefined) {
        return { line, character: base + offset };
      }
    }
    const preChild = getDirectPreChild(node);
    if (preChild !== null) {
      return getPositionWithinPre(preChild.pre, preChild.childIndex);
    }
    return null;
  }
  if (node.nodeType === 1) {
    const el = node as HTMLElement;
    if (el.tagName === 'PRE') {
      return getPositionWithinPre(el, offset);
    }
    if (el.tagName === 'BR') {
      const pre = el.parentElement;
      if (pre === null || pre.tagName !== 'PRE') {
        return null;
      }
      const line = getLineProp(pre);
      if (line !== undefined) {
        return { line, character: 0 };
      }
    }
    if (el.tagName === 'SPAN') {
      const pre = el.parentElement;
      if (pre === null || pre.tagName !== 'PRE') {
        return null;
      }
      const line = getLineProp(pre);
      const base = getCharacterProp(el);
      if (line !== undefined && base !== undefined) {
        let character = base;
        for (let i = 0; i < offset; i++) {
          character += el.childNodes[i]?.textContent?.length ?? 0;
        }
        return { line, character };
      }
    }
    const preChild = getDirectPreChild(el);
    if (preChild !== null) {
      return getPositionWithinPre(preChild.pre, preChild.childIndex);
    }
  }
  return null;
}

function getPositionWithinPre(
  pre: HTMLElement,
  offset: number
): Position | null {
  const line = getLineProp(pre);
  if (line === undefined) {
    return null;
  }
  let character = 0;
  for (let i = 0; i < offset; i++) {
    const c = pre.children[i];
    if (c?.tagName === 'SPAN') {
      const span = c as HTMLElement;
      const o = getCharacterProp(span);
      if (o === undefined) {
        continue;
      }
      const len = span.textContent?.length ?? 0;
      character = o + len;
    }
  }
  return { line, character };
}

function getDirectPreChild(
  node: Node
): { pre: HTMLElement; childIndex: number } | null {
  let current =
    node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
  while (current !== null && current.parentElement !== null) {
    if (current.parentElement.tagName === 'PRE') {
      return {
        pre: current.parentElement,
        childIndex: Array.prototype.indexOf.call(
          current.parentElement.children,
          current
        ),
      };
    }
    current = current.parentElement;
  }
  return null;
}

function getLineProp(el: HTMLElement): number | undefined {
  // oxlint-disable-next-line typescript/no-explicit-any
  return (el as any).LINE as number | undefined;
}

function getCharacterProp(el: HTMLElement): number | undefined {
  // oxlint-disable-next-line typescript/no-explicit-any
  return (el as any).CHAR as number | undefined;
}
