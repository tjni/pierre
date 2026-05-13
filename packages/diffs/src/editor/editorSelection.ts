import type { LineAnnotation } from '../types';
import type {
  Position,
  Range,
  ResolvedTextEdit,
  TextDocument,
  TextDocumentChange,
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
  range: StaticRange,
  direction: SelectionDirection = DirectionNone
): EditorSelection | undefined {
  const start = boundaryToPosition(range.startContainer, range.startOffset);
  const end = boundaryToPosition(range.endContainer, range.endOffset);
  if (start === null || end === null) {
    return undefined;
  }
  return {
    start,
    end,
    direction,
  };
}

/**
 * Resolves the indent edits for a selection.
 */
export function resolveIndentEdits(
  textDocument: TextDocument<unknown>,
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
    const delta = newText.length - deleteLength;
    if (line === start.line) {
      newSelection = {
        ...newSelection,
        start: {
          ...start,
          character: Math.max(0, start.character + delta),
        },
      };
    }
    if (line === end.line) {
      newSelection = {
        ...newSelection,
        end: {
          ...end,
          character: Math.max(0, end.character + delta),
        },
      };
    }
  }
  return [edits, newSelection];
}

/**
 * Maps the cursor move to all selections.
 * TODO(@ije): use move cursor commands
 */
export function mapCursorMove(
  textDocument: TextDocument<unknown>,
  selections: EditorSelection[],
  nextPosition: Position
): EditorSelection[] {
  const primarySelection = selections[selections.length - 1];
  if (primarySelection === undefined) {
    return [];
  }
  const deltaOffset =
    textDocument.offsetAt(nextPosition) -
    textDocument.offsetAt(primarySelection.start);
  const deltaLine = nextPosition.line - primarySelection.start.line;
  const movedOneChar = deltaOffset === 1 || deltaOffset === -1;
  const newSelections: EditorSelection[] = [];
  for (const selection of selections) {
    let newPosition = nextPosition;
    if (selection !== primarySelection) {
      if (deltaLine === 0 || movedOneChar) {
        newPosition = textDocument.positionAt(
          textDocument.offsetAt(selection.start) + deltaOffset
        );
      } else {
        newPosition = {
          line: clamp(
            selection.start.line + deltaLine,
            0,
            textDocument.lineCount - 1
          ),
          character: selection.start.character,
        };
      }
    }
    const newSelection: EditorSelection = {
      start: newPosition,
      end: newPosition,
      direction: DirectionNone,
    };
    const previousSelection = newSelections.at(-1);
    if (
      previousSelection === undefined ||
      comparePosition(previousSelection.start, newSelection.start) !== 0
    ) {
      newSelections.push(newSelection);
    }
  }
  return newSelections;
}

/**
 * Maps the selection shift to all selections.
 */
export function mapSelectionShift(
  textDocument: TextDocument<unknown>,
  selections: EditorSelection[],
  selectionShift: EditorSelection
): EditorSelection[] {
  const primarySelection = selections[selections.length - 1];
  if (primarySelection === undefined) {
    return [];
  }
  const [primaryAnchorOffset, primaryFocusOffset] =
    getSelectionAnchorAndFocusOffsets(textDocument, primarySelection);
  const [shiftAnchorOffset, shiftFocusOffset] =
    getSelectionAnchorAndFocusOffsets(textDocument, selectionShift);
  const anchorDelta = shiftAnchorOffset - primaryAnchorOffset;
  const focusDelta = shiftFocusOffset - primaryFocusOffset;
  const mappedSelections: EditorSelection[] = [];
  for (const selection of selections) {
    const [anchorOffset, focusOffset] = getSelectionAnchorAndFocusOffsets(
      textDocument,
      selection
    );
    const mappedOffsets = createSelectionFromAnchorAndFocusOffsets(
      textDocument,
      anchorOffset + anchorDelta,
      focusOffset + focusDelta
    );
    const newSelection =
      !isCollapsedSelection(mappedOffsets) &&
      selectionShift.direction !== DirectionNone
        ? { ...mappedOffsets, direction: selectionShift.direction }
        : mappedOffsets;
    const previousSelection = mappedSelections.at(-1);
    if (
      previousSelection !== undefined &&
      selectionIntersects(previousSelection, newSelection)
    ) {
      Object.assign(
        previousSelection,
        createSelectionFrom(previousSelection, newSelection)
      );
    } else {
      mappedSelections.push(newSelection);
    }
  }
  return mappedSelections;
}

/**
 * Applies a text change to a selection.
 */
export function applyTextChangeToSelections<LAnnotation>(
  textDocument: TextDocument<LAnnotation>,
  selections: EditorSelection[],
  edit: ResolvedTextEdit,
  lineAnnotations?: LineAnnotation<LAnnotation>[],
  tabSize = 2
): {
  nextSelections: EditorSelection[];
  change?: TextDocumentChange;
} {
  const primarySelection = selections[selections.length - 1];
  if (primarySelection === undefined) {
    return { nextSelections: [] };
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
  const adjustedChange = normalizeLeadingIndentForChange(
    textDocument,
    edit,
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

  const change = textDocument.applyEdits(
    edits,
    true,
    selections,
    undefined,
    lineAnnotations
  );
  const nextSelections = nextSelectionOffsets.map((offsets) =>
    createSelectionFromAnchorAndFocusOffsets(textDocument, ...offsets)
  );
  textDocument.setLastUndoSelectionsAfter(nextSelections);

  return { nextSelections, change };
}

/**
 * Applies a text replace to a selection.
 */
export function applyTextReplaceToSelections<LAnnotation>(
  textDocument: TextDocument<LAnnotation>,
  selections: EditorSelection[],
  texts: string[],
  lineAnnotations?: LineAnnotation<LAnnotation>[]
): {
  nextSelections: EditorSelection[];
  change?: TextDocumentChange;
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

  const change = textDocument.applyEdits(
    edits,
    true,
    selections,
    undefined,
    lineAnnotations
  );
  const nextSelections = nextSelectionOffsets.map((offset) =>
    createSelectionFromAnchorAndFocusOffsets(textDocument, offset, offset)
  );
  textDocument.setLastUndoSelectionsAfter(nextSelections);
  return { nextSelections, change };
}

/**
 * Checks if a selection is collapsed.
 */
export function isCollapsedSelection(selection: EditorSelection): boolean {
  return (
    selection.start.line === selection.end.line &&
    selection.start.character === selection.end.character
  );
}

/**
 * Checks whether selections `a` and `b` intersect.
 */
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

/**
 * Compares two positions.
 */
export function comparePosition(a: Position, b: Position): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.character - b.character;
}

/**
 * Creates a selection from anchor and focus offsets.
 */
export function createSelectionFromAnchorAndFocusOffsets(
  textDocument: TextDocument<unknown>,
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

/**
 * Creates a selection from a anchor and focus selection.
 */
export function createSelectionFrom(
  anchorSelection: EditorSelection,
  focusSelection: EditorSelection
): EditorSelection {
  const anchor =
    anchorSelection.direction === DirectionBackward
      ? anchorSelection.end
      : anchorSelection.start;
  const currentStartOrder = comparePosition(anchor, focusSelection.start);
  const currentEndOrder = comparePosition(anchor, focusSelection.end);
  let focus = focusSelection.end;
  if (currentStartOrder <= 0) {
    focus = focusSelection.end;
  } else if (currentEndOrder >= 0) {
    focus = focusSelection.start;
  } else {
    // When the original anchor sits inside `current`, keep whichever edge
    // stayed at the anchor so drag direction remains stable.
    const anchorAtStart = currentStartOrder === 0;
    focus = anchorAtStart ? focusSelection.end : focusSelection.start;
  }
  const anchorVsFocus = comparePosition(anchor, focus);
  const direction: SelectionDirection =
    anchorVsFocus === 0
      ? DirectionNone
      : anchorVsFocus < 0
        ? DirectionForward
        : DirectionBackward;
  const selectionStart = anchorVsFocus <= 0 ? anchor : focus;
  const selectionEnd = anchorVsFocus <= 0 ? focus : anchor;
  return {
    start: selectionStart,
    end: selectionEnd,
    direction,
  };
}

/**
 * Extends or shrinks the selection `original` using the endpoints of `target`, \
 * matching contenteditable shift + click extend behavior.
 */
export function extendSelection(
  original: EditorSelection,
  target: EditorSelection
): EditorSelection {
  const leftExtended = comparePosition(target.start, original.start) < 0;
  const rightExtended = comparePosition(target.end, original.end) > 0;

  if (leftExtended && !rightExtended) {
    return {
      start: target.start,
      end: original.end,
      direction: DirectionBackward,
    };
  }

  if (rightExtended && !leftExtended) {
    return {
      start: original.start,
      end: target.end,
      direction: DirectionForward,
    };
  }

  if (original.direction === DirectionBackward) {
    return {
      start: target.start,
      end: original.end,
      direction:
        comparePosition(target.start, original.end) === 0
          ? DirectionNone
          : DirectionBackward,
    };
  }

  return {
    start: original.start,
    end: target.end,
    direction:
      comparePosition(original.start, target.end) === 0
        ? DirectionNone
        : DirectionForward,
  };
}

/**
 * Finds the next matching word and updates the selections.
 */
export function findNexMatch(
  textDocument: TextDocument<unknown>,
  selections: EditorSelection[]
): EditorSelection[] | undefined {
  const texts = selections.map((s) => textDocument.getText(s));
  const needle = texts[0];
  if (needle.length === 0 || texts.some((t) => t !== needle)) {
    return undefined;
  }

  const occupied = selections.map(
    (s) =>
      [textDocument.offsetAt(s.start), textDocument.offsetAt(s.end)] as [
        number,
        number,
      ]
  );
  const nextOffset = textDocument.findNextNonOverlappingSubstring(
    needle,
    occupied
  );
  if (nextOffset === undefined) {
    return undefined;
  }
  const added = createSelectionFromAnchorAndFocusOffsets(
    textDocument,
    nextOffset,
    nextOffset + needle.length
  );
  return [...selections, added];
}

export function getDocumentFullSelection(
  textDocument: TextDocument<unknown>
): EditorSelection {
  const lastLine = textDocument.lineCount - 1;
  const lastCharacter = textDocument.getLineText(lastLine)?.length ?? 0;
  return {
    start: { line: 0, character: 0 },
    end: { line: lastLine, character: lastCharacter },
    direction: DirectionForward,
  };
}

export function getDocumentBoundarySelection(
  textDocument: TextDocument<unknown>,
  atEnd: boolean
): EditorSelection {
  const line = atEnd ? textDocument.lineCount - 1 : 0;
  const character = atEnd ? (textDocument.getLineText(line)?.length ?? 0) : 0;
  const start = { line, character };
  return {
    start: start,
    end: start,
    direction: DirectionForward,
  };
}

export function getSelectionText(
  textDocument: TextDocument<unknown>,
  selections: EditorSelection[]
): string {
  return [...selections]
    .sort((a, b) => {
      const startOrder = comparePosition(a.start, b.start);
      if (startOrder !== 0) {
        return startOrder;
      }
      return comparePosition(a.end, b.end);
    })
    .map((selection) => {
      if (isCollapsedSelection(selection)) {
        return textDocument.getLineText(selection.start.line, false);
      }
      return textDocument.getText(selection);
    })
    .join('\n');
}

/**
 * Gets the text node and offset for a selection.
 */
export function getSelectionTextNode(
  lineElement: HTMLElement,
  character: number
): [Node, number] {
  if (lineElement.childElementCount > 0) {
    for (const child of lineElement.children) {
      if (child.hasAttribute('data-char')) {
        const char = Number(child.getAttribute('data-char'));
        const textNode = child.firstChild;
        if (
          textNode !== null &&
          textNode.nodeType === /* Node.TEXT_NODE */ 3 &&
          character >= char &&
          character <= char + (textNode as Text).textContent.length
        ) {
          return [textNode, character - char];
        }
      }
    }
  }
  const textNode = lineElement.firstChild;
  if (textNode !== null && textNode.nodeType === /* Node.TEXT_NODE */ 3) {
    return [textNode, character];
  }
  throw new Error('No text node found');
}

/**
 * Expands a zero-width selection to the word-like segment that contains the caret.
 */
export function expandCollapsedSelectionToWord(
  textDocument: TextDocument<unknown>,
  selection: EditorSelection
): EditorSelection {
  const { line, character } = selection.start;
  const lineText = textDocument.getLineText(line);
  const ch = Math.max(0, Math.min(character, lineText.length));
  const span = expandCollapsedLineWord(lineText, ch);
  if (span === undefined) {
    return selection;
  }
  return {
    start: { line, character: span.start },
    end: { line, character: span.end },
    direction: DirectionForward,
  };
}

function expandCollapsedLineWord(
  lineText: string,
  character: number
): { start: number; end: number } | undefined {
  const segmenter = new Intl.Segmenter(undefined, {
    granularity: 'word',
  });
  for (const seg of segmenter.segment(lineText)) {
    if (seg.isWordLike !== true) {
      continue;
    }
    const lo = seg.index;
    const hi = lo + seg.segment.length;
    if (character >= lo && character < hi) {
      return { start: lo, end: hi };
    }
  }
  for (const seg of segmenter.segment(lineText)) {
    if (seg.isWordLike !== true) {
      continue;
    }
    const lo = seg.index;
    const hi = lo + seg.segment.length;
    if (lo >= character) {
      return { start: lo, end: hi };
    }
  }
  let best: { start: number; end: number } | undefined;
  for (const seg of segmenter.segment(lineText)) {
    if (seg.isWordLike !== true) {
      continue;
    }
    const lo = seg.index;
    const hi = lo + seg.segment.length;
    if (hi <= character) {
      best = { start: lo, end: hi };
    }
  }
  return best;
}

function getSelectionAnchorAndFocusOffsets(
  textDocument: TextDocument<unknown>,
  selection: EditorSelection
): [anchorOffset: number, focusOffset: number] {
  const isBackward = selection.direction === DirectionBackward;
  return [
    textDocument.offsetAt(isBackward ? selection.end : selection.start),
    textDocument.offsetAt(isBackward ? selection.start : selection.end),
  ];
}

// When the user inserts a lone line break, copy the current line's indentation onto the new line.
function expandSingleNewlineInsert(
  textDocument: TextDocument<unknown>,
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
function normalizeLeadingIndentForChange(
  textDocument: TextDocument<unknown>,
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
