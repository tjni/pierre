import type { Position, Range, TextDocument, TextEdit } from './textDocument';

export const DirectionBackward = -1;
export const DirectionNone = 0;
export const DirectionForward = 1;

export type SelectionDirection =
  | typeof DirectionBackward
  | typeof DirectionNone
  | typeof DirectionForward;

export interface EditorSelection extends Range {
  direction: SelectionDirection;
}

/**
 * Converts a selection from a web selection to an editor selection.
 */
export function convertSelection(
  composedRanges: StaticRange[],
  direction: SelectionDirection = DirectionNone
): EditorSelection | null {
  const range = composedRanges[composedRanges.length - 1];
  if (range === undefined) {
    return null;
  }
  const start = boundaryToPosition(range.startContainer, range.startOffset);
  const end = boundaryToPosition(range.endContainer, range.endOffset);
  if (start === null || end === null) {
    return null;
  }
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
  const edits: TextEdit[] = [];
  let newSelection: EditorSelection = { ...selection };
  let endLine = end.line;
  if (start.line < end.line && end.character === 0) {
    endLine--;
  }
  for (let line = start.line; line <= endLine; line++) {
    const lineText = textDocument.getLineText(line);
    if (lineText === undefined) {
      continue;
    }
    const indentUnit = lineText.startsWith('\t') ? '\t' : ' '.repeat(tabSize);
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
      newSelection = {
        ...newSelection,
        start: {
          ...start,
          character: Math.max(0, start.character + delte),
        },
      };
    }
    if (line === end.line) {
      newSelection = {
        ...newSelection,
        end: {
          ...end,
          character: Math.max(0, end.character + delte),
        },
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
    if (parent.tagName === 'DIV') {
      const childIndex = Array.prototype.indexOf.call(parent.childNodes, node);
      const position = getPositionWithinPre(parent, childIndex);
      return position === null
        ? null
        : {
            ...position,
            character:
              position.character + getTextOffset(node.textContent, offset),
          };
    }
    if (parent.tagName === 'SPAN') {
      const pre = parent.parentElement;
      if (pre === null || pre.tagName !== 'DIV') {
        return null;
      }
      const line = getLineIndex(pre);
      const base = getCharacterIndex(parent);
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
    if (el.tagName === 'DIV') {
      return getPositionWithinPre(el, offset);
    }
    if (el.tagName === 'BR') {
      const pre = el.parentElement;
      if (pre === null || pre.tagName !== 'DIV') {
        return null;
      }
      const line = getLineIndex(pre);
      if (line !== undefined) {
        return { line, character: 0 };
      }
    }
    if (el.tagName === 'SPAN') {
      const pre = el.parentElement;
      if (pre === null || pre.tagName !== 'DIV') {
        return null;
      }
      const line = getLineIndex(pre);
      const base = getCharacterIndex(el);
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
  const line = getLineIndex(pre);
  if (line === undefined) {
    return null;
  }
  let character = 0;
  for (let i = 0; i < offset; i++) {
    const c = pre.childNodes[i];
    if (c?.nodeType === 3) {
      character += getTextOffset(c.textContent, c.textContent?.length ?? 0);
      continue;
    }
    if (c?.nodeType === 1 && (c as HTMLElement).tagName === 'SPAN') {
      const span = c as HTMLElement;
      const o = getCharacterIndex(span);
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
    if (current.parentElement.tagName === 'DIV') {
      return {
        pre: current.parentElement,
        childIndex: Array.prototype.indexOf.call(
          current.parentElement.childNodes,
          current
        ),
      };
    }
    current = current.parentElement;
  }
  return null;
}

function getLineIndex(el: HTMLElement): number | undefined {
  const { lineIndex } = el.dataset;
  return lineIndex !== undefined ? parseInt(lineIndex) : undefined;
}

function getCharacterIndex(el: HTMLElement): number | undefined {
  const { char } = el.dataset;
  return char !== undefined ? parseInt(char) : undefined;
}

function getTextOffset(
  text: string | null | undefined,
  offset: number
): number {
  const value = text ?? '';
  const lineBreakIndex = value.search(/[\r\n]/);
  return Math.min(
    offset,
    lineBreakIndex === -1 ? value.length : lineBreakIndex
  );
}
