import { cloneEditorSelection, type EditorSelection } from './selection';

export type ResolvedEdit = { start: number; end: number; text: string };

export type HistoryEntry = {
  /** Forward offset edits from the entry's base text to its final text. */
  forwardEdits: ResolvedEdit[];
  /** Inverse offset edits from the entry's final text back to its base text. */
  inverseEdits: ResolvedEdit[];
  /** Base text length before the entry is applied. */
  textLengthBefore: number;
  /** Final text length after the entry is applied. */
  textLengthAfter: number;
  /** Selection before the transaction (restored on undo). */
  selectionBefore: EditorSelection | EditorSelection[];
  /** Selection after the transaction (restored on redo). */
  selectionAfter?: EditorSelection | EditorSelection[];
  /** Timestamp in ms used to coalesce adjacent edits. */
  timestampMs: number;
};

export function assertNonOverlappingDescending(
  sortedDesc: ResolvedEdit[]
): void {
  for (let i = 0; i < sortedDesc.length - 1; i++) {
    if (sortedDesc[i + 1].end > sortedDesc[i].start) {
      throw new Error('Overlapping text edits are not supported');
    }
  }
}

export function computeTextAfterApplying(
  base: string,
  sortedDesc: ResolvedEdit[]
): string {
  let text = base;
  for (const { start, end, text: insert } of sortedDesc) {
    text = text.slice(0, start) + insert + text.slice(end);
  }
  return text;
}

/** `resolved` in any order; sorted descending internally. */
export function applyOffsetEdits(
  base: string,
  resolved: ResolvedEdit[]
): string {
  const sorted = [...resolved].sort((a, b) => b.start - a.start);
  assertNonOverlappingDescending(sorted);
  return computeTextAfterApplying(base, sorted);
}

export function buildInverseOffsetEdits(
  textBefore: string,
  ascending: ResolvedEdit[]
): ResolvedEdit[] {
  const inverse: ResolvedEdit[] = [];
  for (let i = 0; i < ascending.length; i++) {
    const edit = ascending[i];
    const replacedText = textBefore.slice(edit.start, edit.end);
    let startAfterEdit = edit.start;
    for (let j = 0; j < i; j++) {
      const previousEdit = ascending[j];
      startAfterEdit +=
        previousEdit.text.length - (previousEdit.end - previousEdit.start);
    }
    inverse.push({
      start: startAfterEdit,
      end: startAfterEdit + edit.text.length,
      text: replacedText,
    });
  }
  return inverse;
}

type IntermediateSegment =
  | {
      kind: 'orig';
      sourceStart: number;
      sourceEnd: number;
      outputStart: number;
      outputEnd: number;
    }
  | { kind: 'insert'; text: string; outputStart: number; outputEnd: number };

type ComposedPiece =
  | { kind: 'orig'; start: number; end: number }
  | { kind: 'insert'; text: string };

function cloneResolvedEdits(edits: ResolvedEdit[]) {
  return edits.map((edit) => ({ ...edit }));
}

function buildIntermediateSegments(
  edits: ResolvedEdit[],
  sourceLength: number
): IntermediateSegment[] {
  const segments: IntermediateSegment[] = [];
  let sourceCursor = 0;
  let outputCursor = 0;
  for (const edit of edits) {
    if (sourceCursor < edit.start) {
      const length = edit.start - sourceCursor;
      segments.push({
        kind: 'orig',
        sourceStart: sourceCursor,
        sourceEnd: edit.start,
        outputStart: outputCursor,
        outputEnd: outputCursor + length,
      });
      outputCursor += length;
    }
    if (edit.text.length > 0) {
      segments.push({
        kind: 'insert',
        text: edit.text,
        outputStart: outputCursor,
        outputEnd: outputCursor + edit.text.length,
      });
      outputCursor += edit.text.length;
    }
    sourceCursor = edit.end;
  }
  if (sourceCursor < sourceLength) {
    segments.push({
      kind: 'orig',
      sourceStart: sourceCursor,
      sourceEnd: sourceLength,
      outputStart: outputCursor,
      outputEnd: outputCursor + (sourceLength - sourceCursor),
    });
  }
  return segments;
}

function appendPiece(pieces: ComposedPiece[], piece: ComposedPiece) {
  if (piece.kind === 'insert' && piece.text.length === 0) {
    return;
  }
  if (piece.kind === 'orig' && piece.start === piece.end) {
    return;
  }
  const last = pieces[pieces.length - 1];
  if (last === undefined) {
    pieces.push(piece);
    return;
  }
  if (last.kind === 'insert' && piece.kind === 'insert') {
    last.text += piece.text;
    return;
  }
  if (
    last.kind === 'orig' &&
    piece.kind === 'orig' &&
    last.end === piece.start
  ) {
    last.end = piece.end;
    return;
  }
  pieces.push(piece);
}

function appendIntermediateSlice(
  pieces: ComposedPiece[],
  segments: IntermediateSegment[],
  start: number,
  end: number
) {
  if (start >= end) {
    return;
  }
  for (const segment of segments) {
    if (segment.outputEnd <= start) {
      continue;
    }
    if (segment.outputStart >= end) {
      break;
    }
    const sliceStart = Math.max(start, segment.outputStart);
    const sliceEnd = Math.min(end, segment.outputEnd);
    if (segment.kind === 'orig') {
      const offset = sliceStart - segment.outputStart;
      appendPiece(pieces, {
        kind: 'orig',
        start: segment.sourceStart + offset,
        end: segment.sourceStart + offset + (sliceEnd - sliceStart),
      });
      continue;
    }
    appendPiece(pieces, {
      kind: 'insert',
      text: segment.text.slice(
        sliceStart - segment.outputStart,
        sliceEnd - segment.outputStart
      ),
    });
  }
}

function piecesToEdits(
  pieces: ComposedPiece[],
  sourceLength: number
): ResolvedEdit[] {
  const edits: ResolvedEdit[] = [];
  let sourceCursor = 0;
  let pendingStart: number | undefined;
  let pendingText = '';
  for (const piece of pieces) {
    if (piece.kind === 'insert') {
      pendingStart ??= sourceCursor;
      pendingText += piece.text;
      continue;
    }
    if (piece.start < sourceCursor) {
      throw new Error('Composed edit pieces must preserve source order');
    }
    if (pendingStart !== undefined || piece.start !== sourceCursor) {
      edits.push({
        start: pendingStart ?? sourceCursor,
        end: piece.start,
        text: pendingText,
      });
      pendingStart = undefined;
      pendingText = '';
    }
    sourceCursor = piece.end;
  }
  if (pendingStart !== undefined || sourceCursor !== sourceLength) {
    edits.push({
      start: pendingStart ?? sourceCursor,
      end: sourceLength,
      text: pendingText,
    });
  }
  return edits.filter(
    (edit) => edit.start !== edit.end || edit.text.length > 0
  );
}

export function composeOffsetEdits(
  first: ResolvedEdit[],
  second: ResolvedEdit[],
  sourceLength: number
): ResolvedEdit[] {
  const firstAscending = cloneResolvedEdits(first).sort(
    (a, b) => a.start - b.start
  );
  const secondAscending = cloneResolvedEdits(second).sort(
    (a, b) => a.start - b.start
  );
  const segments = buildIntermediateSegments(firstAscending, sourceLength);
  const pieces: ComposedPiece[] = [];
  const intermediateLength =
    segments.length === 0
      ? sourceLength
      : segments[segments.length - 1].outputEnd;
  let cursor = 0;
  for (const edit of secondAscending) {
    appendIntermediateSlice(pieces, segments, cursor, edit.start);
    appendPiece(pieces, { kind: 'insert', text: edit.text });
    cursor = edit.end;
  }
  appendIntermediateSlice(pieces, segments, cursor, intermediateLength);
  return piecesToEdits(pieces, sourceLength);
}

export class EditHistory {
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  clear(): void {
    this.#undo.length = 0;
    this.#redo.length = 0;
  }

  push(
    textBefore: string,
    resolvedEdits: ResolvedEdit[],
    selectionBefore: EditorSelection | EditorSelection[],
    coalesceWithinMs?: number
  ): void {
    const timestampMs = Date.now();
    const ascendingEdits = [...resolvedEdits].sort((a, b) => a.start - b.start);
    const inverseEdits = buildInverseOffsetEdits(textBefore, ascendingEdits);
    const textLengthBefore = textBefore.length;
    const textLengthAfter =
      textLengthBefore +
      ascendingEdits.reduce(
        (sum, edit) => sum + edit.text.length - (edit.end - edit.start),
        0
      );
    const lastEntry = this.#undo[this.#undo.length - 1];
    if (
      lastEntry !== undefined &&
      this.#redo.length === 0 &&
      coalesceWithinMs !== undefined &&
      coalesceWithinMs >= 0 &&
      timestampMs - lastEntry.timestampMs <= coalesceWithinMs
    ) {
      lastEntry.forwardEdits = composeOffsetEdits(
        lastEntry.forwardEdits,
        ascendingEdits,
        lastEntry.textLengthBefore
      );
      lastEntry.inverseEdits = composeOffsetEdits(
        inverseEdits,
        lastEntry.inverseEdits,
        textLengthAfter
      );
      lastEntry.textLengthAfter = textLengthAfter;
      lastEntry.timestampMs = timestampMs;
      return;
    }
    this.#undo.push({
      forwardEdits: cloneResolvedEdits(ascendingEdits),
      inverseEdits: inverseEdits,
      textLengthBefore,
      textLengthAfter,
      selectionBefore: cloneEditorSelection(selectionBefore),
      timestampMs,
    });
    this.#redo.length = 0;
  }

  setLastUndoSelectionAfter(
    selection: EditorSelection | EditorSelection[]
  ): void {
    const lastEntry = this.#undo[this.#undo.length - 1];
    if (lastEntry !== undefined) {
      lastEntry.selectionAfter = cloneEditorSelection(selection);
    }
  }

  /** Moves the latest undo entry to the redo stack and returns it, or `undefined` if empty. */
  popUndoToRedo(): HistoryEntry | void {
    const entry = this.#undo.pop();
    if (entry !== undefined) {
      this.#redo.push(entry);
      return entry;
    }
  }

  /** Moves the latest redo entry back to the undo stack and returns it, or `undefined` if empty. */
  popRedoToUndo(): HistoryEntry | void {
    const entry = this.#redo.pop();
    if (entry !== undefined) {
      this.#undo.push(entry);
      return entry;
    }
  }
}
