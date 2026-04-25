import { type EditorSelection, type EditorTextChange } from './editorSelection';

export type HistoryEntry = {
  /** Forward offset edits from the entry's base text to its final text. */
  forwardEdits: EditorTextChange[];
  /** Inverse offset edits from the entry's final text back to its base text. */
  inverseEdits: EditorTextChange[];
  /** Base text length before the entry is applied. */
  textLengthBefore: number;
  /** Final text length after the entry is applied. */
  textLengthAfter: number;
  /** Selection before the transaction (restored on undo). */
  selectionsBefore: EditorSelection[];
  /** Selection after the transaction (restored on redo). */
  selectionsAfter?: EditorSelection[];
};

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
    resolvedEdits: EditorTextChange[],
    selectionsBefore: EditorSelection[],
    selectionsAfter?: EditorSelection[]
  ): void {
    const forwardEdits = [...resolvedEdits].sort((a, b) => a.start - b.start);
    const inverseEdits = buildInverseOffsetEdits(textBefore, forwardEdits);
    const textLengthBefore = textBefore.length;
    const textLengthAfter =
      textLengthBefore +
      forwardEdits.reduce(
        (sum, edit) => sum + edit.text.length - (edit.end - edit.start),
        0
      );
    this.#undo.push({
      forwardEdits: forwardEdits.map((edit) => ({ ...edit })),
      inverseEdits: inverseEdits,
      textLengthBefore,
      textLengthAfter,
      selectionsBefore: selectionsBefore?.map((selection) => ({
        ...selection,
      })),
      selectionsAfter: selectionsAfter?.map((selection) => ({ ...selection })),
    });
    this.#redo.length = 0;
  }

  setLastUndoSelectionsAfter(selections: EditorSelection[]): void {
    const lastEntry = this.#undo[this.#undo.length - 1];
    if (lastEntry !== undefined) {
      lastEntry.selectionsAfter = selections.map((selection) => ({
        ...selection,
      }));
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

export function applyOffsetEdits(
  base: string,
  edits: EditorTextChange[]
): string {
  const sortedEdits = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 0; i < sortedEdits.length - 1; i++) {
    if (sortedEdits[i + 1].end > sortedEdits[i].start) {
      throw new Error('Overlapping text edits are not supported');
    }
  }
  let text = base;
  for (const { start, end, text: insert } of sortedEdits) {
    text = text.slice(0, start) + insert + text.slice(end);
  }
  return text;
}

export function buildInverseOffsetEdits(
  textBefore: string,
  ascending: EditorTextChange[]
): EditorTextChange[] {
  const inverse: EditorTextChange[] = [];
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
