import {
  type EditorSelection,
  type EditorTextChange,
  SelectionDirection,
} from './editorSelection';
import { type Position, TextDocument, type TextEdit } from './textDocument';

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
      direction: SelectionDirection.None,
    };
  });
}

export function applySelectionTextChange(
  textDocument: TextDocument,
  selections: EditorSelection[],
  change: EditorTextChange
): EditorSelection[] {
  const primarySelection = selections[selections.length - 1];
  if (primarySelection === undefined) {
    return [];
  }
  const primaryStartOffset = textDocument.offsetAt(primarySelection.start);
  const primaryEndOffset = textDocument.offsetAt(primarySelection.end);
  const relativeStart = change.start - primaryStartOffset;
  const relativeEnd = change.end - primaryEndOffset;
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
    edits.push({
      range: {
        start: textDocument.positionAt(mergedGroup.start),
        end: textDocument.positionAt(mergedGroup.end),
      },
      newText: change.text,
    });
    const nextOffsets: [number, number] = [
      mergedGroup.start + offsetDelta + change.text.length,
      mergedGroup.start + offsetDelta + change.text.length,
    ];
    for (const index of mergedGroup.indices) {
      nextSelectionOffsets[index] = nextOffsets;
    }
    offsetDelta += change.text.length - (mergedGroup.end - mergedGroup.start);
    mergedGroup = undefined;
  };
  for (const entry of ordered) {
    const startOffset = Math.max(0, entry.start + relativeStart);
    const endOffset = Math.max(startOffset, entry.end + relativeEnd);
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
  textDocument.applyEdits(edits, true, selections);
  const nextSelections = nextSelectionOffsets.map((offsets) =>
    createSelectionFromAnchorAndFocusOffsets(textDocument, ...offsets)
  );
  textDocument.setLastUndoSelectionsAfter(nextSelections);
  return nextSelections;
}

export function applySelectionTextReplace(
  textDocument: TextDocument,
  selections: EditorSelection[],
  texts: readonly string[]
): EditorSelection[] {
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
    edits.push({
      range: {
        start: textDocument.positionAt(entry.start),
        end: textDocument.positionAt(entry.end),
      },
      newText: entry.text,
    });
    nextSelectionOffsets[entry.index] =
      entry.start + offsetDelta + entry.text.length;
    offsetDelta += entry.text.length - (entry.end - entry.start);
  }
  textDocument.applyEdits(edits, true, selections);
  const nextSelections = nextSelectionOffsets.map((offset) =>
    createSelectionFromAnchorAndFocusOffsets(textDocument, offset, offset)
  );
  textDocument.setLastUndoSelectionsAfter(nextSelections);
  return nextSelections;
}

function createSelectionFromAnchorAndFocusOffsets(
  textDocument: TextDocument,
  anchorOffset: number,
  focusOffset: number
): EditorSelection {
  const direction =
    anchorOffset === focusOffset
      ? SelectionDirection.None
      : anchorOffset < focusOffset
        ? SelectionDirection.Forward
        : SelectionDirection.Backward;
  const start = Math.min(anchorOffset, focusOffset);
  const end = Math.max(anchorOffset, focusOffset);
  return {
    start: textDocument.positionAt(start),
    end: textDocument.positionAt(end),
    direction,
  };
}
