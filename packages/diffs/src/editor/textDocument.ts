import { splitFileContents } from '../utils/splitFileContents';
import { EditHistory } from './editHistory';
import { type EditorSelection } from './editorSelection';

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
 * A line buffer is a line of text with its offset.
 */
class LineBuffer {
  constructor(
    public readonly offset: number,
    public readonly text: string
  ) {}
}

/**
 * A vscode-languageserver-textdocument compatible text document.
 */
export class TextDocument {
  static trimEOL(text: string): string {
    let end = text.length;
    while (end > 0 && isEOL(text.charCodeAt(end - 1))) {
      end--;
    }
    return text.slice(0, end);
  }

  #uri: string;
  #languageId: string;
  #version: number;
  #lines: LineBuffer[] = [];
  #hasCRLF = false;
  #history = new EditHistory();

  constructor(
    uri: string,
    text: string,
    languageId = 'plaintext',
    version = 0
  ) {
    this.#uri = new URL(uri, 'file://').toString();
    this.#languageId = languageId;
    this.#version = version;
    this.#setLineBuffers(text, false);
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
    return this.#lines.length;
  }

  get lines(): string[] {
    return this.#lines.map((line) => line.text);
  }

  get canUndo(): boolean {
    return this.#history.canUndo;
  }

  get canRedo(): boolean {
    return this.#history.canRedo;
  }

  get EOF(): string {
    return this.#hasCRLF ? '\r\n' : '\n';
  }

  getText(range?: Range): string {
    if (range !== undefined) {
      const start = this.offsetAt(range.start);
      const end = this.offsetAt(range.end);
      return this.#sliceText(start, end);
    }
    return this.#lines.map((line) => line.text).join('');
  }

  getLineText(line: number, trimEOL = true): string {
    if (line < 0 || line >= this.#lines.length) {
      throw new Error(`Line index out of range: ${line}`);
    }
    const text = this.#lines[line].text;
    return trimEOL ? TextDocument.trimEOL(text) : text;
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
    const textBefore = this.getText();
    if (updateHistory && selectionsBefore !== undefined) {
      this.#history.push(
        textBefore,
        resolvedEdits,
        selectionsBefore,
        selectionsAfter
      );
    }
    this.#applyResolvedEdits(resolvedEdits);
    this.#version++;
  }

  setLastUndoSelectionsAfter(selections: EditorSelection[]): void {
    this.#history.setLastUndoSelectionsAfter(selections);
  }

  undo(): EditorSelection[] | undefined {
    const entry = this.#history.popUndoToRedo();
    if (entry === undefined) {
      return undefined;
    }
    this.#setDocumentText(applyTextEdits(this.getText(), entry.inverseEdits));
    return entry.selectionsBefore !== undefined
      ? entry.selectionsBefore.map((selection) => ({ ...selection }))
      : undefined;
  }

  redo(): EditorSelection[] | undefined {
    const entry = this.#history.popRedoToUndo();
    if (entry === undefined) {
      return undefined;
    }
    this.#setDocumentText(applyTextEdits(this.getText(), entry.forwardEdits));
    return entry.selectionsAfter !== undefined
      ? entry.selectionsAfter.map((selection) => ({ ...selection }))
      : undefined;
  }

  positionAt(offset: number): Position {
    const documentLength = this.#getDocumentLength();
    const clampedOffset = Math.max(Math.min(offset, documentLength), 0);
    const line = this.#lineAtOffset(clampedOffset);
    const lineStart = this.#lines[line].offset;
    const lineLength = lineLengthWithoutEOL(this.#lines[line].text);
    const character = Math.min(clampedOffset - lineStart, lineLength);
    return { line, character };
  }

  offsetAt(position: Position): number {
    const { line, character } = position;
    const documentLength = this.#getDocumentLength();
    if (line >= this.#lines.length) {
      return documentLength;
    } else if (line < 0) {
      return 0;
    }
    const lineOffset = this.#lines[line].offset;
    if (character <= 0) {
      return lineOffset;
    }
    const lineLength = lineLengthWithoutEOL(this.#lines[line].text);
    return Math.min(lineOffset + character, lineOffset + lineLength);
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

  #setDocumentText(text: string, incrementVersion = true): void {
    this.#setLineBuffers(text, incrementVersion);
  }

  #setLineBuffers(text: string, incrementVersion: boolean): void {
    let offset = 0;
    let hasCRLF = false;
    const parts = splitFileContents(text);
    const lines = parts.map((part) => {
      const line = new LineBuffer(offset, part);
      if (part.endsWith('\r\n')) {
        hasCRLF = true;
      }
      offset += part.length;
      return line;
    });
    this.#lines = lines;
    this.#hasCRLF = hasCRLF;
    if (incrementVersion) {
      this.#version++;
    }
  }

  #getDocumentLength(): number {
    if (this.#lines.length === 0) {
      return 0;
    }
    const lastLine = this.#lines[this.#lines.length - 1];
    return lastLine.offset + lastLine.text.length;
  }

  #lineAtOffset(offset: number): number {
    let lo = 0;
    let hi = this.#lines.length - 1;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo + 1) / 2);
      if (this.#lines[mid].offset <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  #sliceText(start: number, end: number): string {
    if (start >= end) {
      return '';
    }
    const startLine = this.#lineAtOffset(start);
    const endLine = this.#lineAtOffset(Math.max(start, end - 1));
    if (startLine === endLine) {
      const line = this.#lines[startLine];
      const localStart = start - line.offset;
      const localEnd = end - line.offset;
      return line.text.slice(localStart, localEnd);
    }

    let result = '';
    for (let lineIndex = startLine; lineIndex <= endLine; lineIndex++) {
      const line = this.#lines[lineIndex];
      const localStart = lineIndex === startLine ? start - line.offset : 0;
      const localEnd =
        lineIndex === endLine ? end - line.offset : line.text.length;
      result += line.text.slice(localStart, localEnd);
    }
    return result;
  }

  #applyResolvedEdits(edits: ResolvedTextEdit[]): void {
    const sortedEdits = [...edits].sort((a, b) => b.start - a.start);
    for (let i = 0; i < sortedEdits.length - 1; i++) {
      if (sortedEdits[i + 1].end > sortedEdits[i].start) {
        throw new Error('Overlapping text edits are not supported');
      }
    }
    for (const edit of sortedEdits) {
      this.#applySingleEdit(edit);
    }
    this.#hasCRLF = this.#lines.some((line) => line.text.includes('\r\n'));
  }

  #applySingleEdit(edit: ResolvedTextEdit): void {
    const start = this.positionAt(edit.start);
    const end = this.positionAt(edit.end);
    const startLine = start.line;
    const endLine = end.line;
    const startLineParts = splitLineEnding(this.#lines[startLine].text);
    const endLineParts = splitLineEnding(this.#lines[endLine].text);
    const head = startLineParts.content.slice(0, start.character);
    const tail = endLineParts.content.slice(end.character) + endLineParts.eol;
    const merged = `${head}${edit.text}${tail}`;
    const nextLineTexts = splitFileContents(merged);
    const nextLines: LineBuffer[] = nextLineTexts.map(
      (text) => new LineBuffer(0, text)
    );

    this.#lines.splice(startLine, endLine - startLine + 1, ...nextLines);
    let nextOffset =
      startLine > 0
        ? this.#lines[startLine - 1].offset +
          this.#lines[startLine - 1].text.length
        : 0;
    for (let i = startLine; i < this.#lines.length; i++) {
      // @ts-ignore update the line offset
      this.#lines[i].offset = nextOffset;
      nextOffset += this.#lines[i].text.length;
    }
  }
}

function isEOL(char: number) {
  return char === /* \n */ 10 || char === 13 /* \r */;
}

function lineLengthWithoutEOL(text: string): number {
  let length = text.length;
  while (length > 0 && isEOL(text.charCodeAt(length - 1))) {
    length--;
  }
  return length;
}

function splitLineEnding(text: string): { content: string; eol: string } {
  let contentEnd = text.length;
  while (contentEnd > 0 && isEOL(text.charCodeAt(contentEnd - 1))) {
    contentEnd--;
  }
  return {
    content: text.slice(0, contentEnd),
    eol: text.slice(contentEnd),
  };
}

export function applyTextEdits(
  originalText: string,
  edits: ResolvedTextEdit[]
): string {
  const sortedEdits = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 0; i < sortedEdits.length - 1; i++) {
    if (sortedEdits[i + 1].end > sortedEdits[i].start) {
      throw new Error('Overlapping text edits are not supported');
    }
  }
  let text = originalText;
  for (const { start, end, text: insert } of sortedEdits) {
    text = text.slice(0, start) + insert + text.slice(end);
  }
  return text;
}
