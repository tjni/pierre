import { type EditorSelection } from './editorSelection';
import { EditStack } from './editStack';
import { PieceTable } from './pieceTable';

/**
 * Position in a text document expressed as zero-based line and character offset.
 * The offsets are based on a UTF-16 string representation. So a string of the form
 * `a𐐀b` the character offset of the character `a` is 0, the character offset of `𐐀`
 * is 1 and the character offset of b is 3 since `𐐀` is represented using two code
 * units in UTF-16.
 *
 * Positions are line end character agnostic. So you can not specify a position that
 * denotes `\r|\n` or `\n|` where `|` represents the character offset.
 */
export interface Position {
  /**
   * Line position in a document (zero-based).
   *
   * If a line number is greater than the number of lines in a document, it
   * defaults back to the number of lines in the document.
   * If a line number is negative, it defaults to 0.
   *
   * The above two properties are implementation specific.
   */
  readonly line: number;
  /**
   * Character offset on a line in a document (zero-based).
   *
   * The meaning of this offset is determined by the negotiated
   * `PositionEncodingKind`.
   *
   * If the character value is greater than the line length it defaults back
   * to the line length. This property is implementation specific.
   */
  readonly character: number;
}

/**
 * A range in a text document expressed as (zero-based) start and end positions.
 *
 * If you want to specify a range that contains a line including the line ending
 * character(s) then use an end position denoting the start of the next line.
 * For example:
 * ```ts
 * {
 *     start: { line: 5, character: 23 }
 *     end : { line 6, character : 0 }
 * }
 * ```
 */
export interface Range {
  /**
   * The range's start position.
   */
  readonly start: Position;
  /**
   * The range's end position.
   */
  readonly end: Position;
}

/**
 * A text edit applicable to a text document.
 */
export interface TextEdit {
  /**
   * The range of the text document to be manipulated. To insert
   * text into a document create a range where start === end.
   */
  readonly range: Range;
  /**
   * The string to be inserted. For delete operations use an
   * empty string.
   */
  readonly newText: string;
}

/** Different with `TextEdit`, the range has been resolved to offsets. */
export type ResolvedTextEdit = {
  /** The start offset of the text change. */
  readonly start: number;
  /** The end offset of the text change. */
  readonly end: number;
  /**
   * The string to be inserted. For delete operations use an
   * empty string.
   */
  readonly text: string;
};

/**
 * A vscode-languageserver-textdocument compatible text document.
 */
export class TextDocument {
  #uri: string;
  #languageId: string;
  #version: number;
  #pieceTable: PieceTable;
  #editStack = new EditStack();

  constructor(
    uri: string,
    text: string,
    languageId = 'plaintext',
    version = 0
  ) {
    this.#uri = new URL(uri, 'file://').toString();
    this.#languageId = languageId;
    this.#version = version;
    this.#pieceTable = new PieceTable(text);
  }

  get uri(): string {
    return this.#uri;
  }

  get languageId(): string {
    return this.#languageId;
  }

  get version(): number {
    return this.#version;
  }

  get lineCount(): number {
    return this.#pieceTable.lineCount;
  }

  get lines(): string[] {
    const lines: string[] = [];
    for (let line = 0; line < this.#pieceTable.lineCount; line++) {
      lines.push(this.getLineText(line, false));
    }
    return lines;
  }

  get canUndo(): boolean {
    return this.#editStack.canUndo;
  }

  get canRedo(): boolean {
    return this.#editStack.canRedo;
  }

  positionAt(offset: number): Position {
    return this.#pieceTable.positionAt(offset);
  }

  offsetAt(position: Position): number {
    return this.#pieceTable.offsetAt(position);
  }

  getText(range?: Range): string {
    return this.#pieceTable.getText(range);
  }

  getLineText(line: number, trimEOL = true): string {
    return this.#pieceTable.getLineText(line, trimEOL);
  }

  getTextSlice(start: number, end: number): string {
    return this.#pieceTable.getTextSlice(start, end);
  }

  applyEdits(
    edits: TextEdit[],
    updateHistory = false,
    selectionsBefore?: EditorSelection[],
    selectionsAfter?: EditorSelection[]
  ): void {
    if (edits.length === 0) {
      return;
    }
    const resolvedEdits = edits.map((edit) => this.#resolveEdit(edit));
    if (updateHistory && selectionsBefore !== undefined) {
      this.#editStack.push(
        this,
        resolvedEdits,
        this.#version,
        this.#version + 1,
        selectionsBefore,
        selectionsAfter
      );
    }
    this.#applyResolvedEdits(resolvedEdits);
    this.#version++;
  }

  setLastUndoSelectionsAfter(selections: EditorSelection[]): void {
    this.#editStack.setLastUndoSelectionsAfter(selections);
  }

  undo(): EditorSelection[] | undefined {
    const entry = this.#editStack.popUndoToRedo();
    if (entry === undefined) {
      return undefined;
    }
    this.#applyResolvedEdits(entry.inverseEdits);
    this.#version = entry.versionBefore;
    return entry.selectionsBefore !== undefined
      ? entry.selectionsBefore.map((selection) => ({ ...selection }))
      : undefined;
  }

  redo(): EditorSelection[] | undefined {
    const entry = this.#editStack.popRedoToUndo();
    if (entry === undefined) {
      return undefined;
    }
    this.#applyResolvedEdits(entry.forwardEdits);
    this.#version = entry.versionAfter;
    return entry.selectionsAfter !== undefined
      ? entry.selectionsAfter.map((selection) => ({ ...selection }))
      : undefined;
  }

  #resolveEdit(edit: TextEdit): ResolvedTextEdit {
    let start = this.offsetAt(edit.range.start);
    let end = this.offsetAt(edit.range.end);
    if (start > end) {
      const t = start;
      start = end;
      end = t;
    }
    return { start, end, text: edit.newText };
  }

  #applyResolvedEdits(edits: ResolvedTextEdit[]): void {
    const sortedEdits = [...edits].sort((a, b) => b.start - a.start);
    for (let i = 0; i < sortedEdits.length - 1; i++) {
      if (sortedEdits[i + 1].end > sortedEdits[i].start) {
        throw new Error('Overlapping text edits are not supported');
      }
    }
    for (const edit of sortedEdits) {
      this.#pieceTable.delete(edit.start, edit.end - edit.start);
      this.#pieceTable.insert(edit.text, edit.start);
    }
  }
}
