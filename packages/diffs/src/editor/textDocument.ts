import {
  applyOffsetEdits,
  EditHistory,
  type ResolvedEdit,
} from './editHistory';
import { cloneEditorSelection, type IEditorSelection } from './selection';

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
  line: number;
  /**
   * Character offset on a line in a document (zero-based).
   *
   * The meaning of this offset is determined by the negotiated
   * `PositionEncodingKind`.
   *
   * If the character value is greater than the line length it defaults back
   * to the line length. This property is implementation specific.
   */
  character: number;
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
  start: Position;
  /**
   * The range's end position.
   */
  end: Position;
}

/**
 * A text edit applicable to a text document.
 */
export interface TextEdit {
  /**
   * The range of the text document to be manipulated. To insert
   * text into a document create a range where start === end.
   */
  range: Range;
  /**
   * The string to be inserted. For delete operations use an
   * empty string.
   */
  newText: string;
}

type LineOffsets = number[] & {
  hasCRLF?: boolean;
};

/**
 * A vscode-languageserver-textdocument compatible text document.
 */
export class TextDocument {
  #uri: string;
  #text: string;
  #languageId: string;
  #version: number;
  #lineOffsets: LineOffsets;
  #history = new EditHistory();

  constructor(
    uri: string,
    text: string,
    languageId = 'plaintext',
    version = 0
  ) {
    this.#uri = new URL(uri, 'file://').toString();
    this.#text = text;
    this.#lineOffsets = computeLineOffsets(text);
    this.#languageId = languageId;
    this.#version = version;
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
    return this.#lineOffsets.length;
  }

  get canUndo(): boolean {
    return this.#history.canUndo;
  }

  get canRedo(): boolean {
    return this.#history.canRedo;
  }

  get EOF(): string {
    return this.#lineOffsets.hasCRLF === true ? '\r\n' : '\n';
  }

  getText(range?: Range): string {
    if (range !== undefined) {
      const start = this.offsetAt(range.start);
      const end = this.offsetAt(range.end);
      return this.#text.slice(start, end);
    }
    return this.#text;
  }

  getLineText(line: number): string | undefined {
    if (line < 0 || line >= this.#lineOffsets.length) {
      return undefined;
    }
    const start = this.#lineOffsets[line];
    const end = this.#lineOffsets[line + 1] ?? this.#text.length;
    return this.#text.slice(start, this.#ensureBeforeEOL(end, start));
  }

  setText(text: string): void {
    this.#history.clear();
    this.#setDocumentText(text);
  }

  applyEdits(edits: TextEdit[], selectionBefore?: IEditorSelection): void {
    if (edits.length === 0) {
      return;
    }
    const resolvedEdits = this.#resolveEdits(edits);
    const textBefore = this.#text;
    const newText = applyOffsetEdits(textBefore, resolvedEdits);
    if (selectionBefore !== undefined) {
      this.#history.push(textBefore, resolvedEdits, selectionBefore, 500);
    }
    this.#setDocumentText(newText);
  }

  setLastUndoSelectionAfter(selection: IEditorSelection): void {
    this.#history.setLastUndoSelectionAfter(selection);
  }

  undo(): IEditorSelection | undefined {
    const entry = this.#history.popUndoToRedo();
    if (entry === undefined) {
      return undefined;
    }
    this.#setDocumentText(applyOffsetEdits(this.#text, entry.inverseEdits));
    return entry.selectionBefore !== undefined
      ? cloneEditorSelection(entry.selectionBefore)
      : undefined;
  }

  redo(): IEditorSelection | undefined {
    const entry = this.#history.popRedoToUndo();
    if (entry === undefined) {
      return undefined;
    }
    this.#setDocumentText(applyOffsetEdits(this.#text, entry.forwardEdits));
    return entry.selectionAfter !== undefined
      ? cloneEditorSelection(entry.selectionAfter)
      : undefined;
  }

  #resolveEdits(edits: TextEdit[]): ResolvedEdit[] {
    return edits.map((edit) => this.#resolveEdit(edit));
  }

  #resolveEdit(edit: TextEdit): ResolvedEdit {
    let start = this.offsetAt(edit.range.start);
    let end = this.offsetAt(edit.range.end);
    if (start > end) {
      const t = start;
      start = end;
      end = t;
    }
    return { start, end, text: edit.newText };
  }

  #setDocumentText(text: string, incrementVersion = true) {
    this.#text = text;
    this.#lineOffsets = computeLineOffsets(text);
    if (incrementVersion) {
      this.#version++;
    }
  }

  positionAt(offset: number): Position {
    const columnOffset = Math.max(Math.min(offset, this.#text.length), 0);
    const lineOffsets = this.#lineOffsets;
    let lo = 0;
    let hi = lineOffsets.length - 1;
    if (hi === 0) {
      return { line: 0, character: columnOffset };
    }
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo + 1) / 2);
      if (lineOffsets[mid] <= columnOffset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const line = lo;
    const character =
      this.#ensureBeforeEOL(columnOffset, lineOffsets[line]) - lineOffsets[lo];
    return { line, character };
  }

  offsetAt(position: Position): number {
    const { line, character } = position;
    const textLength = this.#text.length;
    const lineOffsets = this.#lineOffsets;
    if (line >= lineOffsets.length) {
      return textLength;
    } else if (line < 0) {
      return 0;
    }
    const lineOffset = lineOffsets[line];
    if (character <= 0) {
      return lineOffset;
    }
    const nextLineOffset =
      line + 1 < lineOffsets.length ? lineOffsets[line + 1] : textLength;
    const offset = Math.min(lineOffset + character, nextLineOffset);
    return this.#ensureBeforeEOL(offset, lineOffset);
  }

  #ensureBeforeEOL(end: number, start: number) {
    while (end > start && isEOL(this.#text.charCodeAt(end - 1))) {
      end--;
    }
    return end;
  }
}

function isEOL(char: number) {
  return char === /* \n */ 10 || char === 13 /* \r */;
}

function computeLineOffsets(text: string): LineOffsets {
  const offsets: LineOffsets = [0];
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    if (isEOL(char)) {
      if (
        char === 13 /* \r */ &&
        i + 1 < text.length &&
        text.charCodeAt(i + 1) === /* \n */ 10
      ) {
        offsets.hasCRLF = true;
        i++;
      }
      offsets.push(i + 1);
    }
  }
  return offsets;
}
