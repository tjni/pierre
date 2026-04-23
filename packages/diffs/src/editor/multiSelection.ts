import { applyOffsetEdits } from './editHistory';
import {
  comparePosition,
  createSelection,
  type ISelection,
  type ISelections,
  normalizeSelections,
  SelectionDirection,
} from './selection';
import { TextDocument, type TextEdit } from './textDocument';

type SelectionEditMapping = {
  edits: TextEdit[];
  nextSelections: ISelections;
};

type SelectionTextChange = {
  start: number;
  end: number;
  text: string;
  selectionStart: number;
  selectionEnd: number;
  direction: SelectionDirection;
};

export function mapSelectionTextChange(
  textDocument: TextDocument,
  selections: readonly ISelection[],
  change: SelectionTextChange
): SelectionEditMapping {
  const primarySelection = selections[selections.length - 1];
  if (primarySelection === undefined) {
    return { edits: [], nextSelections: [] };
  }
  const primaryStartOffset = textDocument.offsetAt(primarySelection.start);
  const primaryEndOffset = textDocument.offsetAt(primarySelection.end);
  const relativeStart = change.start - primaryStartOffset;
  const relativeEnd = change.end - primaryEndOffset;
  const postSelectionStartOffset = change.selectionStart - change.start;
  const postSelectionEndOffset = change.selectionEnd - change.start;
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
  const nextSelectionOffsets: Array<[number, number] | undefined> = Array.from({
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
      mergedGroup.start + offsetDelta + postSelectionStartOffset,
      mergedGroup.start + offsetDelta + postSelectionEndOffset,
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
  const nextDocument = new TextDocument(
    textDocument.uri,
    applyOffsetEdits(
      textDocument.getText(),
      edits.map((edit) => ({
        start: textDocument.offsetAt(edit.range.start),
        end: textDocument.offsetAt(edit.range.end),
        text: edit.newText,
      }))
    ),
    textDocument.languageId
  );
  return {
    edits,
    nextSelections: normalizeSelections(
      nextSelectionOffsets.map((offsets) => {
        const [start, end] = offsets!;
        return createSelection(
          ...toLineCharacter(nextDocument, start),
          ...toLineCharacter(nextDocument, end),
          change.direction
        );
      })
    ),
  };
}

export function mapSelectionRangeChange(
  textDocument: TextDocument,
  selections: readonly ISelection[],
  nextPrimarySelection: ISelection
): ISelections {
  const primarySelection = selections[selections.length - 1];
  if (primarySelection === undefined) {
    return [];
  }
  const primaryAnchorOffset = getSelectionAnchorOffset(
    textDocument,
    primarySelection
  );
  const primaryFocusOffset = getSelectionFocusOffset(
    textDocument,
    primarySelection
  );
  const nextPrimaryAnchorOffset = getSelectionAnchorOffset(
    textDocument,
    nextPrimarySelection
  );
  const nextPrimaryFocusOffset = getSelectionFocusOffset(
    textDocument,
    nextPrimarySelection
  );
  const anchorDelta = nextPrimaryAnchorOffset - primaryAnchorOffset;
  const focusDelta = nextPrimaryFocusOffset - primaryFocusOffset;
  const textLength = textDocument.getText().length;
  return normalizeSelections(
    selections.map((selection) =>
      createSelectionFromAnchorAndFocusOffsets(
        textDocument,
        clampOffset(
          getSelectionAnchorOffset(textDocument, selection) + anchorDelta,
          textLength
        ),
        clampOffset(
          getSelectionFocusOffset(textDocument, selection) + focusDelta,
          textLength
        )
      )
    )
  );
}

export function mapSelectionTextReplace(
  textDocument: TextDocument,
  selections: readonly ISelection[],
  texts: readonly string[]
): SelectionEditMapping {
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
  const nextDocument = createTextDocumentAfterEdits(textDocument, edits);
  return {
    edits,
    nextSelections: normalizeSelections(
      nextSelectionOffsets.map((offset) =>
        createSelection(
          ...toLineCharacter(nextDocument, offset),
          ...toLineCharacter(nextDocument, offset),
          SelectionDirection.None
        )
      )
    ),
  };
}

export function getOrderedSelectionText(
  textDocument: TextDocument,
  selections: readonly ISelection[]
): string[] {
  return [...selections]
    .sort((a, b) => {
      const startOrder = comparePosition(a.start, b.start);
      if (startOrder !== 0) {
        return startOrder;
      }
      return comparePosition(a.end, b.end);
    })
    .map((selection) => textDocument.getText(selection));
}

function createTextDocumentAfterEdits(
  textDocument: TextDocument,
  edits: readonly TextEdit[]
) {
  return new TextDocument(
    textDocument.uri,
    applyOffsetEdits(
      textDocument.getText(),
      edits.map((edit) => ({
        start: textDocument.offsetAt(edit.range.start),
        end: textDocument.offsetAt(edit.range.end),
        text: edit.newText,
      }))
    ),
    textDocument.languageId
  );
}

function getSelectionAnchorOffset(
  textDocument: TextDocument,
  selection: ISelection
) {
  return selection.direction === SelectionDirection.Backward
    ? textDocument.offsetAt(selection.end)
    : textDocument.offsetAt(selection.start);
}

function getSelectionFocusOffset(
  textDocument: TextDocument,
  selection: ISelection
) {
  return selection.direction === SelectionDirection.Backward
    ? textDocument.offsetAt(selection.start)
    : textDocument.offsetAt(selection.end);
}

function createSelectionFromAnchorAndFocusOffsets(
  textDocument: TextDocument,
  anchorOffset: number,
  focusOffset: number
) {
  const direction =
    anchorOffset === focusOffset
      ? SelectionDirection.None
      : anchorOffset < focusOffset
        ? SelectionDirection.Forward
        : SelectionDirection.Backward;
  const start = Math.min(anchorOffset, focusOffset);
  const end = Math.max(anchorOffset, focusOffset);
  return createSelection(
    ...toLineCharacter(textDocument, start),
    ...toLineCharacter(textDocument, end),
    direction
  );
}

function clampOffset(offset: number, textLength: number) {
  return Math.max(0, Math.min(offset, textLength));
}

function toLineCharacter(
  textDocument: TextDocument,
  offset: number
): [number, number] {
  const position = textDocument.positionAt(offset);
  return [position.line, position.character];
}
