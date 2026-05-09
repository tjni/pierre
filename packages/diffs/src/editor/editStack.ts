import type { LineAnnotation } from '../types';
import type { EditorSelection } from './editorSelection';
import type { ResolvedTextEdit, TextDocument } from './textDocument';

/** Largest number of undo or redo entries kept; oldest entries drop first once exceeded. */
const DEFAULT_EDIT_STACK_MAX_ENTRIES = 100;

export interface EditStackEntry<LAnnotation> {
  /** Forward offset edits from the entry's base text to its final text. */
  forwardEdits: ResolvedTextEdit[];
  /** Inverse offset edits from the entry's final text back to its base text. */
  inverseEdits: ResolvedTextEdit[];
  /** Document version before the entry is applied. */
  versionBefore: number;
  /** Document version after the entry is applied. */
  versionAfter: number;
  /** Selection before the transaction. */
  selectionsBefore?: EditorSelection[];
  /** Selection after the transaction. */
  selectionsAfter?: EditorSelection[];
  /** Line annotations before the transaction. */
  lineAnnotationsBefore?: LineAnnotation<LAnnotation>[];
  /** Line annotations after the transaction. */
  lineAnnotationsAfter?: LineAnnotation<LAnnotation>[];
}

export interface EditStackOptions {
  maxEntries?: number;
}

export class EditStack<LAnnotation> {
  #undoStack: EditStackEntry<LAnnotation>[] = [];
  #redoStack: EditStackEntry<LAnnotation>[] = [];
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

  clearRedo(): void {
    this.#redoStack.length = 0;
  }

  push(entry: EditStackEntry<LAnnotation>): void {
    this.#undoStack.push(entry);
    this.clearRedo();
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

  setLastUndoLineAnnotationsAfter(
    lineAnnotations: LineAnnotation<LAnnotation>[]
  ): void {
    const lastEntry = this.#undoStack[this.#undoStack.length - 1];
    if (lastEntry !== undefined) {
      lastEntry.lineAnnotationsAfter = lineAnnotations.slice();
    }
  }

  peekUndo(): EditStackEntry<LAnnotation> | undefined {
    return this.#undoStack[this.#undoStack.length - 1];
  }

  replaceLastUndo(entry: EditStackEntry<LAnnotation>): void {
    if (this.#undoStack.length === 0) {
      this.push(entry);
      return;
    }
    this.#undoStack[this.#undoStack.length - 1] = entry;
    this.clearRedo();
  }

  /** Moves the latest undo entry to the redo stack and returns it, or `undefined` if empty. */
  popUndoToRedo(): EditStackEntry<LAnnotation> | void {
    const entry = this.#undoStack.pop();
    if (entry !== undefined) {
      this.#redoStack.push(entry);
      return entry;
    }
  }

  /** Moves the latest redo entry back to the undo stack and returns it, or `undefined` if empty. */
  popRedoToUndo(): EditStackEntry<LAnnotation> | void {
    const entry = this.#redoStack.pop();
    if (entry !== undefined) {
      this.#undoStack.push(entry);
      return entry;
    }
  }
}

export function createEditStackEntry<LAnnotation>(
  textDocument: TextDocument<LAnnotation>,
  resolvedEdits: ResolvedTextEdit[],
  versionBefore: number,
  versionAfter: number,
  selectionsBefore?: EditorSelection[],
  selectionsAfter?: EditorSelection[],
  lineAnnotationsBefore?: LineAnnotation<LAnnotation>[],
  lineAnnotationsAfter?: LineAnnotation<LAnnotation>[]
): EditStackEntry<LAnnotation> {
  const forwardEdits = [...resolvedEdits].sort((a, b) => a.start - b.start);
  const inverseEdits: ResolvedTextEdit[] = [];
  for (let i = 0, offsetDelta = 0; i < forwardEdits.length; i++) {
    const edit = forwardEdits[i];
    const replacedText = textDocument.getTextSlice(edit.start, edit.end);
    const startAfterEdit = edit.start + offsetDelta;
    inverseEdits.push({
      start: startAfterEdit,
      end: startAfterEdit + edit.text.length,
      text: replacedText,
    });
    offsetDelta += edit.text.length - (edit.end - edit.start);
  }
  return {
    forwardEdits: forwardEdits.map((edit) => ({ ...edit })),
    inverseEdits: inverseEdits,
    versionBefore,
    versionAfter,
    selectionsBefore: selectionsBefore?.map((selection) => ({
      ...selection,
    })),
    selectionsAfter: selectionsAfter?.map((selection) => ({ ...selection })),
    lineAnnotationsBefore: lineAnnotationsBefore?.slice(),
    lineAnnotationsAfter: lineAnnotationsAfter?.slice(),
  };
}
