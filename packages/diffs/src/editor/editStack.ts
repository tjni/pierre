import type { EditorSelection } from './editorSelection';
import type { ResolvedTextEdit } from './textDocument';

/** Largest number of undo or redo entries kept; oldest entries drop first once exceeded. */
const DEFAULT_EDIT_STACK_MAX_ENTRIES = 100;

interface EditSource {
  getTextSlice(start: number, end: number): string;
}

interface EditStackEntry {
  /** Forward offset edits from the entry's base text to its final text. */
  forwardEdits: ResolvedTextEdit[];
  /** Inverse offset edits from the entry's final text back to its base text. */
  inverseEdits: ResolvedTextEdit[];
  /** Document version before the entry is applied. */
  versionBefore: number;
  /** Document version after the entry is applied. */
  versionAfter: number;
  /** Selection before the transaction (restored on undo). */
  selectionsBefore: EditorSelection[];
  /** Selection after the transaction (restored on redo). */
  selectionsAfter?: EditorSelection[];
}

export interface EditStackOptions {
  maxEntries?: number;
}

export class EditStack {
  #undoStack: EditStackEntry[] = [];
  #redoStack: EditStackEntry[] = [];
  #maxEntries: number;

  constructor(options?: EditStackOptions) {
    this.#maxEntries = Math.max(
      1,
      options?.maxEntries ?? DEFAULT_EDIT_STACK_MAX_ENTRIES
    );
  }

  get canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  clear(): void {
    this.#undoStack.length = 0;
    this.#redoStack.length = 0;
  }

  push(
    source: EditSource,
    resolvedEdits: ResolvedTextEdit[],
    versionBefore: number,
    versionAfter: number,
    selectionsBefore: EditorSelection[],
    selectionsAfter?: EditorSelection[]
  ): void {
    const forwardEdits = [...resolvedEdits].sort((a, b) => a.start - b.start);
    const inverseEdits = buildInverseOffsetEdits(source, forwardEdits);
    this.#undoStack.push({
      forwardEdits: forwardEdits.map((edit) => ({ ...edit })),
      inverseEdits: inverseEdits,
      versionBefore,
      versionAfter,
      selectionsBefore: selectionsBefore?.map((selection) => ({
        ...selection,
      })),
      selectionsAfter: selectionsAfter?.map((selection) => ({ ...selection })),
    });
    this.#redoStack.length = 0;
    if (this.#undoStack.length > this.#maxEntries) {
      this.#undoStack.shift();
    }
  }

  setLastUndoSelectionsAfter(selections: EditorSelection[]): void {
    const lastEntry = this.#undoStack[this.#undoStack.length - 1];
    if (lastEntry !== undefined) {
      lastEntry.selectionsAfter = selections.map((selection) => ({
        ...selection,
      }));
    }
  }

  /** Moves the latest undo entry to the redo stack and returns it, or `undefined` if empty. */
  popUndoToRedo(): EditStackEntry | void {
    const entry = this.#undoStack.pop();
    if (entry !== undefined) {
      this.#redoStack.push(entry);
      return entry;
    }
  }

  /** Moves the latest redo entry back to the undo stack and returns it, or `undefined` if empty. */
  popRedoToUndo(): EditStackEntry | void {
    const entry = this.#redoStack.pop();
    if (entry !== undefined) {
      this.#undoStack.push(entry);
      return entry;
    }
  }
}

function buildInverseOffsetEdits(
  source: EditSource,
  ascending: ResolvedTextEdit[]
): ResolvedTextEdit[] {
  const inverse: ResolvedTextEdit[] = [];
  for (let i = 0, offsetDelta = 0; i < ascending.length; i++) {
    const edit = ascending[i];
    const replacedText = source.getTextSlice(edit.start, edit.end);
    const startAfterEdit = edit.start + offsetDelta;
    inverse.push({
      start: startAfterEdit,
      end: startAfterEdit + edit.text.length,
      text: replacedText,
    });
    offsetDelta += edit.text.length - (edit.end - edit.start);
  }
  return inverse;
}
