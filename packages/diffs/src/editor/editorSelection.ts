import type { LineAnnotation } from '../types';
import { applyDocumentChangeToLineAnnotations } from './editorLineAnnotations';
import type {
  Position,
  Range,
  ResolvedTextEdit,
  TextDocument,
  TextEdit,
} from './textDocument';

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

export function mapSelectionMove(
  textDocument: TextDocument,
  selections: readonly EditorSelection[],
  nextPosition: Position
): EditorSelection[] {
  const primarySelection = selections[selections.length - 1];
  if (primarySelection === undefined) {
    return [];
  }
  const deltaLine = nextPosition.line - primarySelection.start.line;
  const deltaCharacter =
    nextPosition.character - primarySelection.start.character;
  const isMoveToLineStart =
    deltaLine === 0 && nextPosition.character === 0 && deltaCharacter < -1;
  const isMoveToLineEnd =
    deltaLine === 0 &&
    nextPosition.character ===
      textDocument.getLineText(nextPosition.line)?.length &&
    deltaCharacter > 1;
  return selections.map((selection) => {
    let newLine = selection.start.line + deltaLine;
    let newCharacter = selection.start.character + deltaCharacter;
    if (selection !== primarySelection) {
      if (isMoveToLineStart) {
        newCharacter = 0;
      } else if (isMoveToLineEnd) {
        newCharacter = textDocument.getLineText(newLine)?.length ?? 0;
      }
    }
    const newPosition: Position = {
      line: newLine,
      character: newCharacter,
    };
    return {
      start: newPosition,
      end: newPosition,
      direction: DirectionNone,
    };
  });
}

export function mapSelectionRangeMove(
  textDocument: TextDocument,
  selections: readonly EditorSelection[],
  nextAnchor: Position,
  nextFocus: Position
): EditorSelection[] {
  const primarySelection = selections[selections.length - 1];
  if (primarySelection === undefined) {
    return [];
  }
  const [primaryAnchorOffset, primaryFocusOffset] =
    getSelectionAnchorAndFocusOffsets(textDocument, primarySelection);
  const anchorDelta = textDocument.offsetAt(nextAnchor) - primaryAnchorOffset;
  const focusDelta = textDocument.offsetAt(nextFocus) - primaryFocusOffset;
  return selections.map((selection) => {
    const [anchorOffset, focusOffset] = getSelectionAnchorAndFocusOffsets(
      textDocument,
      selection
    );
    return createSelectionFromAnchorAndFocusOffsets(
      textDocument,
      anchorOffset + anchorDelta,
      focusOffset + focusDelta
    );
  });
}

export function applyTextChangeToSelections<LAnnotation>(
  textDocument: TextDocument,
  selections: EditorSelection[],
  change: ResolvedTextEdit,
  lineAnnotations?: LineAnnotation<LAnnotation>[],
  tabSize = 2
): {
  nextSelections: EditorSelection[];
  newLineAnnotations: LineAnnotation<LAnnotation>[] | undefined;
} {
  const primarySelection = selections[selections.length - 1];
  if (primarySelection === undefined) {
    return { nextSelections: [], newLineAnnotations: undefined };
  }
  const primaryStartOffset = textDocument.offsetAt(primarySelection.start);
  const primaryEndOffset = textDocument.offsetAt(primarySelection.end);
  const ordered = selections
    .map((selection, index) => ({
      selection,
      index,
      start: textDocument.offsetAt(selection.start),
      end: textDocument.offsetAt(selection.end),
      isPrimary: index === selections.length - 1,
    }))
    .sort((a, b) => {
      const startOrder = a.start - b.start;
      if (startOrder !== 0) {
        return startOrder;
      }
      const endOrder = a.end - b.end;
      if (endOrder !== 0) {
        return endOrder;
      }
      return a.index - b.index;
    });
  const adjustedChange = normalizeLeadingIndentDeleteChange(
    textDocument,
    change,
    primarySelection,
    tabSize
  );
  const edits: TextEdit[] = [];
  const nextSelectionOffsets: Array<[number, number]> = Array.from({
    length: selections.length,
  });
  let offsetDelta = 0;
  let mergedGroup:
    | {
        start: number;
        end: number;
        indices: number[];
      }
    | undefined;
  const finalizeMergedGroup = () => {
    if (mergedGroup === undefined) {
      return;
    }
    const newText = expandSingleNewlineInsert(
      textDocument,
      adjustedChange.text,
      mergedGroup.start
    );
    edits.push({
      range: {
        start: textDocument.positionAt(mergedGroup.start),
        end: textDocument.positionAt(mergedGroup.end),
      },
      newText,
    });
    const nextOffsets: [number, number] = [
      mergedGroup.start + offsetDelta + newText.length,
      mergedGroup.start + offsetDelta + newText.length,
    ];
    for (const index of mergedGroup.indices) {
      nextSelectionOffsets[index] = nextOffsets;
    }
    offsetDelta += newText.length - (mergedGroup.end - mergedGroup.start);
    mergedGroup = undefined;
  };
  for (const entry of ordered) {
    const startOffset = Math.max(
      0,
      entry.start + (adjustedChange.start - primaryStartOffset)
    );
    const endOffset = Math.max(
      startOffset,
      entry.end + (adjustedChange.end - primaryEndOffset)
    );
    if (mergedGroup !== undefined && startOffset < mergedGroup.end) {
      mergedGroup.end = Math.max(mergedGroup.end, endOffset);
      mergedGroup.indices.push(entry.index);
      continue;
    }
    finalizeMergedGroup();
    mergedGroup = {
      start: startOffset,
      end: endOffset,
      indices: [entry.index],
    };
  }
  finalizeMergedGroup();
  textDocument.applyEdits(edits, true, selections, undefined, lineAnnotations);
  const nextSelections = nextSelectionOffsets.map((offsets) =>
    createSelectionFromAnchorAndFocusOffsets(textDocument, ...offsets)
  );
  textDocument.setLastUndoSelectionsAfter(nextSelections);

  let newLineAnnotations: LineAnnotation<LAnnotation>[] | undefined;
  if (lineAnnotations !== undefined && textDocument.lastChange !== undefined) {
    newLineAnnotations = applyDocumentChangeToLineAnnotations<LAnnotation>(
      textDocument.lastChange,
      lineAnnotations
    );
    if (newLineAnnotations !== undefined) {
      textDocument.setLastUndoLineAnnotationsAfter(newLineAnnotations);
    }
  }

  return { nextSelections, newLineAnnotations };
}

export function applyTextReplaceToSelections<LAnnotation>(
  textDocument: TextDocument,
  selections: EditorSelection[],
  texts: readonly string[],
  lineAnnotations?: LineAnnotation<LAnnotation>[]
): {
  nextSelections: EditorSelection[];
  newLineAnnotations: LineAnnotation<LAnnotation>[] | undefined;
} {
  if (selections.length !== texts.length) {
    throw new Error(
      'Selection text replacements must match the selection count'
    );
  }
  const ordered = selections
    .map((selection, index) => ({
      index,
      start: textDocument.offsetAt(selection.start),
      end: textDocument.offsetAt(selection.end),
      text: texts[index],
    }))
    .sort((a, b) => {
      const startOrder = a.start - b.start;
      if (startOrder !== 0) {
        return startOrder;
      }
      const endOrder = a.end - b.end;
      if (endOrder !== 0) {
        return endOrder;
      }
      return a.index - b.index;
    });
  const edits: TextEdit[] = [];
  const nextSelectionOffsets: number[] = Array.from({
    length: selections.length,
  });
  let offsetDelta = 0;
  let previousEditEnd = -1;
  for (const entry of ordered) {
    if (entry.start < previousEditEnd) {
      throw new Error('Overlapping multi-selection edits are not supported');
    }
    previousEditEnd = entry.end;
    const newText = expandSingleNewlineInsert(
      textDocument,
      entry.text,
      entry.start
    );
    edits.push({
      range: {
        start: textDocument.positionAt(entry.start),
        end: textDocument.positionAt(entry.end),
      },
      newText,
    });
    nextSelectionOffsets[entry.index] =
      entry.start + offsetDelta + newText.length;
    offsetDelta += newText.length - (entry.end - entry.start);
  }
  textDocument.applyEdits(edits, true, selections, undefined, lineAnnotations);
  const nextSelections = nextSelectionOffsets.map((offset) =>
    createSelectionFromAnchorAndFocusOffsets(textDocument, offset, offset)
  );
  textDocument.setLastUndoSelectionsAfter(nextSelections);

  let newLineAnnotations: LineAnnotation<LAnnotation>[] | undefined;
  if (lineAnnotations !== undefined && textDocument.lastChange !== undefined) {
    newLineAnnotations = applyDocumentChangeToLineAnnotations<LAnnotation>(
      textDocument.lastChange,
      lineAnnotations
    );
    if (newLineAnnotations !== undefined) {
      textDocument.setLastUndoLineAnnotationsAfter(newLineAnnotations);
    }
  }

  return { nextSelections, newLineAnnotations };
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

export function createSelectionFromAnchorAndFocusOffsets(
  textDocument: TextDocument,
  anchorOffset: number,
  focusOffset: number
): EditorSelection {
  const direction =
    anchorOffset === focusOffset
      ? DirectionNone
      : anchorOffset < focusOffset
        ? DirectionForward
        : DirectionBackward;
  const start = Math.min(anchorOffset, focusOffset);
  const end = Math.max(anchorOffset, focusOffset);
  return {
    start: textDocument.positionAt(start),
    end: textDocument.positionAt(end),
    direction,
  };
}

function getSelectionAnchorAndFocusOffsets(
  textDocument: TextDocument,
  selection: EditorSelection
): [anchorOffset: number, focusOffset: number] {
  const isBackward = selection.direction === DirectionBackward;
  return [
    textDocument.offsetAt(isBackward ? selection.end : selection.start),
    textDocument.offsetAt(isBackward ? selection.start : selection.end),
  ];
}

/** When the user inserts a lone line break, copy the current line's indentation onto the new line. */
function expandSingleNewlineInsert(
  textDocument: TextDocument,
  insertText: string,
  insertStartOffset: number
): string {
  if (insertText !== '\n' && insertText !== '\r\n') {
    return insertText;
  }
  const line = textDocument.positionAt(insertStartOffset).line;
  const lineText = textDocument.getLineText(line);
  let indentLen = 0;
  for (; indentLen < lineText.length; indentLen++) {
    const ch = lineText[indentLen];
    if (ch !== ' ' && ch !== '\t') {
      break;
    }
  }
  if (indentLen === 0) {
    return insertText;
  }
  return '\n' + lineText.slice(0, indentLen);
}

// Expands a backspace over leading spaces into one soft-tab width so mixed hard/soft indentation
// behaves like the explicit outdent command.
function normalizeLeadingIndentDeleteChange(
  textDocument: TextDocument,
  change: ResolvedTextEdit,
  primarySelection: EditorSelection,
  tabSize: number
): ResolvedTextEdit {
  if (
    change.text !== '' ||
    change.start !== change.end - 1 ||
    primarySelection.start.line !== primarySelection.end.line ||
    primarySelection.start.character !== primarySelection.end.character
  ) {
    return change;
  }
  const caretPosition = textDocument.positionAt(change.end);
  if (caretPosition.character === 0) {
    return change;
  }
  const primaryOffset = textDocument.offsetAt(primarySelection.start);
  if (change.end !== primaryOffset) {
    return change;
  }
  const lineText = textDocument.getLineText(caretPosition.line);
  const leadingText = lineText.slice(0, caretPosition.character);
  if (/[^ \t]/.test(leadingText)) {
    return change;
  }
  if (lineText[caretPosition.character - 1] === '\t') {
    return change;
  }
  const softTabStart = Math.max(0, caretPosition.character - tabSize);
  const softTabText = lineText.slice(softTabStart, caretPosition.character);
  if (softTabText.length === tabSize && /^ +$/.test(softTabText)) {
    return {
      ...change,
      start: change.end - softTabText.length,
    };
  }
  return change;
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
