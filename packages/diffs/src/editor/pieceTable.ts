import type { Position, Range } from './textDocument';

type Piece = {
  readonly source: PieceSourceType;
  readonly offset: number;
  readonly length: number;
};

type PieceSegment = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly lineOffsets: number[];
};

enum PieceSourceType {
  Original = 0,
  Added = 1,
}

// A text buffer is a string with its line offsets.
class TextBuffer {
  lineOffsets: number[];

  constructor(public text: string) {
    this.lineOffsets = createLineOffsets(text);
  }

  // the append operation is efficient because it only appends
  // elements to the lineOffsets array in the end
  append(text: string): number {
    const offset = this.text.length;
    const appendedLineOffsets = createLineOffsets(text);
    for (let i = 1; i < appendedLineOffsets.length; i++) {
      this.lineOffsets.push(offset + appendedLineOffsets[i]);
    }
    this.text += text;
    return offset;
  }
}

// A node in the piece tree, which is a red-black tree
class PieceNode {
  static Red = 0;
  static Black = 1;

  left: PieceNode | null = null;
  right: PieceNode | null = null;
  parent: PieceNode | null = null;

  constructor(
    public piece: Piece,
    public color: number = PieceNode.Red,
    public subtreeLength: number = piece.length
  ) {}

  updateSubtreeLength(): void {
    this.subtreeLength =
      (this.left?.subtreeLength ?? 0) +
      this.piece.length +
      (this.right?.subtreeLength ?? 0);
  }
}

/**
 * A piece table is a data structure that allows for efficient insertion and deletion of text.
 * It is a tree of pieces, where each piece is a segment of text that is either original or added.
 * The tree is balanced to ensure that the operations are efficient.
 * Inspired by https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation
 */
export class PieceTable {
  #original: TextBuffer;
  #add = new TextBuffer('');
  #root: PieceNode | null = null;
  #length = 0;
  #lineCount = 0;

  constructor(originalText: string) {
    this.#original = new TextBuffer(originalText);
    this.#setPieces([
      {
        source: PieceSourceType.Original,
        offset: 0,
        length: originalText.length,
      },
    ]);
  }

  get lineCount(): number {
    return this.#lineCount;
  }

  getText(range?: Range): string {
    if (range === undefined) {
      return this.#textFromPieces();
    }
    const start = this.offsetAt(range.start);
    const end = this.offsetAt(range.end);
    return this.getTextSlice(start, end);
  }

  getLineText(line: number): string {
    const offset = this.#getLineOffset(line);
    if (offset === undefined) {
      throw new Error(`Line index out of range: ${line}`);
    }
    return this.getTextSlice(offset[0], offset[1]);
  }

  getTextSlice(start: number, end: number): string {
    if (start >= end) {
      return '';
    }

    const sliceStart = clamp(start, 0, this.#length);
    const sliceEnd = clamp(end, sliceStart, this.#length);
    if (sliceStart >= sliceEnd) {
      return '';
    }

    const location = this.#findPieceAtOffset(sliceStart);
    if (location === undefined) {
      return '';
    }

    const chunks: string[] = [];
    let [node, offsetInPiece] = location as [PieceNode | null, number];
    let remaining = sliceEnd - sliceStart;
    while (node !== null && remaining > 0) {
      const takeLength = Math.min(node.piece.length - offsetInPiece, remaining);
      const buffer = this.#bufferFor(node.piece.source);
      chunks.push(
        buffer.text.slice(
          node.piece.offset + offsetInPiece,
          node.piece.offset + offsetInPiece + takeLength
        )
      );
      remaining -= takeLength;
      offsetInPiece = 0;
      node = this.#nextNode(node);
    }

    return chunks.join('');
  }

  charAt(offset: number): string {
    const location = this.#findPieceAtOffset(offset);
    if (location === undefined) {
      return '';
    }

    const [node, offsetInPiece] = location;
    const buffer = this.#bufferFor(node.piece.source);
    return buffer.text.charAt(node.piece.offset + offsetInPiece);
  }

  includes(needle: string): boolean {
    if (needle.length === 0) {
      return true;
    }

    const prefixTable = createPrefixTable(needle);
    let matched = 0;
    let found = false;
    this.#forEachPieceSegment((segment) => {
      for (let offset = segment.start; offset < segment.end; offset++) {
        const charCode = segment.text.charCodeAt(offset);
        while (matched > 0 && charCode !== needle.charCodeAt(matched)) {
          matched = prefixTable[matched - 1];
        }
        if (charCode === needle.charCodeAt(matched)) {
          matched++;
        }
        if (matched === needle.length) {
          found = true;
          return false;
        }
      }
      return true;
    });
    return found;
  }

  insert(text: string, offset: number): void {
    if (text.length === 0) {
      return;
    }

    const insertOffset = clamp(offset, 0, this.#length);
    const addOffset = this.#add.append(text);
    const insertedPiece = {
      source: PieceSourceType.Added,
      offset: addOffset,
      length: text.length,
    };
    const pieces = this.#pieces();
    const nextPieces: Piece[] = [];

    let cursor = 0;
    let inserted = false;

    for (const piece of pieces) {
      const pieceEnd = cursor + piece.length;
      if (!inserted && insertOffset <= pieceEnd) {
        const splitOffset = insertOffset - cursor;
        if (splitOffset > 0) {
          nextPieces.push({ ...piece, length: splitOffset });
        }
        nextPieces.push(insertedPiece);
        if (splitOffset < piece.length) {
          nextPieces.push({
            ...piece,
            offset: piece.offset + splitOffset,
            length: piece.length - splitOffset,
          });
        }
        inserted = true;
      } else {
        nextPieces.push(piece);
      }
      cursor = pieceEnd;
    }

    if (!inserted) {
      nextPieces.push(insertedPiece);
    }

    this.#setPieces(nextPieces);
  }

  delete(offset: number, length: number): void {
    if (length <= 0 || this.#length === 0) {
      return;
    }

    const start = clamp(offset, 0, this.#length);
    const end = clamp(start + length, start, this.#length);
    if (start === end) {
      return;
    }

    const nextPieces: Piece[] = [];
    let cursor = 0;
    for (const piece of this.#pieces()) {
      const pieceStart = cursor;
      const pieceEnd = cursor + piece.length;
      const keepBefore = clamp(start - pieceStart, 0, piece.length);
      const keepAfter = clamp(pieceEnd - end, 0, piece.length);

      if (keepBefore > 0) {
        nextPieces.push({ ...piece, length: keepBefore });
      }
      if (keepAfter > 0) {
        nextPieces.push({
          ...piece,
          offset: piece.offset + piece.length - keepAfter,
          length: keepAfter,
        });
      }
      cursor = pieceEnd;
    }

    this.#setPieces(nextPieces);
  }

  positionAt(offset: number): Position {
    const clampedOffset = clamp(offset, 0, this.#length);
    if (this.#length === 0) {
      return { line: 0, character: 0 };
    }

    let position: Position | undefined;
    const scan = this.#forEachLineBreak((lineBreak, line) => {
      if (clampedOffset < lineBreak[1]) {
        position = {
          line,
          character: clampedOffset - lineBreak[0],
        };
        return false;
      }
      return true;
    });

    if (position !== undefined) {
      return position;
    }

    return {
      line: scan.nextLine,
      character: clampedOffset - scan.nextLineStart,
    };
  }

  offsetAt(position: Position): number {
    if (position.line < 0 || this.#length === 0) {
      return 0;
    }
    if (position.line >= this.#lineCount) {
      throw new Error(`Line index out of range: ${position.line}`);
    }
    const offset = this.#getLineOffset(position.line);
    if (offset === undefined) {
      throw new Error(`Line index out of range: ${position.line}`);
    }
    const character = clamp(position.character, 0, offset[1] - offset[0]);
    return offset[0] + character;
  }

  #findPieceAtOffset(
    offset: number
  ): [node: PieceNode, offsetInPiece: number] | undefined {
    if (offset < 0 || offset >= this.#length) {
      return undefined;
    }

    let node = this.#root;
    let remaining = offset;
    while (node !== null) {
      const leftLength = node.left?.subtreeLength ?? 0;
      if (remaining < leftLength) {
        node = node.left;
        continue;
      }

      remaining -= leftLength;
      if (remaining < node.piece.length) {
        return [node, remaining];
      }

      remaining -= node.piece.length;
      node = node.right;
    }

    return undefined;
  }

  #nextNode(node: PieceNode): PieceNode | null {
    if (node.right !== null) {
      let next = node.right;
      while (next.left !== null) {
        next = next.left;
      }
      return next;
    }

    let current = node;
    while (current.parent !== null && current === current.parent.right) {
      current = current.parent;
    }
    return current.parent;
  }

  #getLineOffset(line: number): [start: number, end: number] | undefined {
    if (line < 0) {
      throw new Error(`Line index out of range: ${line}`);
    }
    if (this.#length === 0) {
      if (line === 0) {
        return [0, 0];
      }
      throw new Error(`Line index out of range: ${line}`);
    }

    let offset: [start: number, end: number] | undefined;
    const scan = this.#forEachLineBreak((lineBreak, ln) => {
      if (ln === line) {
        offset = lineBreak;
        return false;
      }
      return true;
    });

    if (offset !== undefined) {
      return offset;
    }
    if (scan.nextLine !== line) {
      throw new Error(`Line index out of range: ${line}`);
    }
    return [scan.nextLineStart, this.#length];
  }

  #textFromPieces(): string {
    const chunks: string[] = [];
    this.#forEachPieceSegment((segment) => {
      chunks.push(segment.text.slice(segment.start, segment.end));
    });
    return chunks.join('');
  }

  #forEachPieceSegment(
    callback: (segment: PieceSegment) => boolean | void
  ): void {
    this.#walk(this.#root, (node) => {
      const buffer = this.#bufferFor(node.piece.source);
      return callback({
        text: buffer.text,
        lineOffsets: buffer.lineOffsets,
        start: node.piece.offset,
        end: node.piece.offset + node.piece.length,
      });
    });
  }

  #forEachLineBreak(
    callback: (
      lineBreak: [start: number, end: number],
      line: number
    ) => boolean | void
  ): {
    nextLine: number;
    nextLineStart: number;
  } {
    let line = 0;
    let lineStart = 0;
    let documentOffset = 0;

    this.#forEachPieceSegment((segment) => {
      const lineOffsetStart = upperBound(segment.lineOffsets, segment.start);
      const lineOffsetEnd = upperBound(segment.lineOffsets, segment.end);
      for (let i = lineOffsetStart; i < lineOffsetEnd; i++) {
        const bufferLineOffset = segment.lineOffsets[i];
        const endWithEOL = documentOffset + (bufferLineOffset - segment.start);

        if (callback([lineStart, endWithEOL], line) === false) {
          return false;
        }

        line++;
        lineStart = endWithEOL;
      }

      documentOffset += segment.end - segment.start;
      return true;
    });

    return { nextLine: line, nextLineStart: lineStart };
  }

  #bufferFor(source: PieceSourceType): TextBuffer {
    return source === PieceSourceType.Original ? this.#original : this.#add;
  }

  #pieces(): Piece[] {
    const pieces: Piece[] = [];
    this.#walk(this.#root, (node) => {
      pieces.push(node.piece);
    });
    return pieces;
  }

  #setPieces(pieces: Piece[]): void {
    const coalescedPieces = coalescePieces(pieces);
    this.#root = null;
    for (const piece of coalescedPieces) {
      this.#insertRightmost(piece);
    }
    this.#recomputeSubtreeLength(this.#root);
    this.#computeBufferMetadata();
  }

  #computeBufferMetadata(): void {
    let length = 0;
    let lineCount = 0;

    this.#forEachPieceSegment((segment) => {
      length += segment.end - segment.start;
      lineCount += lineFeedCount(segment);
    });

    this.#length = length;
    this.#lineCount = length === 0 ? 0 : lineCount + 1;
  }

  #recomputeSubtreeLength(node: PieceNode | null): number {
    if (node === null) {
      return 0;
    }

    node.subtreeLength =
      this.#recomputeSubtreeLength(node.left) +
      node.piece.length +
      this.#recomputeSubtreeLength(node.right);
    return node.subtreeLength;
  }

  #walk(
    node: PieceNode | null,
    visit: (node: PieceNode) => boolean | void
  ): boolean {
    if (node === null) {
      return true;
    }
    if (!this.#walk(node.left, visit)) {
      return false;
    }
    if (visit(node) === false) {
      return false;
    }
    return this.#walk(node.right, visit);
  }

  #insertRightmost(piece: Piece): void {
    const node = new PieceNode(piece);
    if (this.#root === null) {
      node.color = PieceNode.Black;
      this.#root = node;
      return;
    }

    let parent = this.#root;
    while (parent.right !== null) {
      parent = parent.right;
    }
    parent.right = node;
    node.parent = parent;

    let current = node;
    while (current.parent?.color === PieceNode.Red) {
      const parent = current.parent;
      const grandparent = parent.parent;
      if (grandparent === null) {
        break;
      }

      if (parent === grandparent.left) {
        const uncle = grandparent.right;
        if (uncle?.color === PieceNode.Red) {
          parent.color = PieceNode.Black;
          uncle.color = PieceNode.Black;
          grandparent.color = PieceNode.Red;
          current = grandparent;
        } else {
          if (current === parent.right) {
            current = parent;
            this.#rotateLeft(current);
          }
          current.parent!.color = PieceNode.Black;
          grandparent.color = PieceNode.Red;
          this.#rotateRight(grandparent);
        }
      } else {
        const uncle = grandparent.left;
        if (uncle?.color === PieceNode.Red) {
          parent.color = PieceNode.Black;
          uncle.color = PieceNode.Black;
          grandparent.color = PieceNode.Red;
          current = grandparent;
        } else {
          if (current === parent.left) {
            current = parent;
            this.#rotateRight(current);
          }
          current.parent!.color = PieceNode.Black;
          grandparent.color = PieceNode.Red;
          this.#rotateLeft(grandparent);
        }
      }
    }

    if (this.#root !== null) {
      this.#root.color = PieceNode.Black;
    }
  }

  #rotateLeft(node: PieceNode): void {
    const right = node.right;
    if (right === null) {
      return;
    }

    node.right = right.left;
    if (right.left !== null) {
      right.left.parent = node;
    }
    right.parent = node.parent;
    if (node.parent === null) {
      this.#root = right;
    } else if (node === node.parent.left) {
      node.parent.left = right;
    } else {
      node.parent.right = right;
    }
    right.left = node;
    node.parent = right;
    node.updateSubtreeLength();
    right.updateSubtreeLength();
  }

  #rotateRight(node: PieceNode): void {
    const left = node.left;
    if (left === null) {
      return;
    }

    node.left = left.right;
    if (left.right !== null) {
      left.right.parent = node;
    }
    left.parent = node.parent;
    if (node.parent === null) {
      this.#root = left;
    } else if (node === node.parent.right) {
      node.parent.right = left;
    } else {
      node.parent.left = left;
    }
    left.right = node;
    node.parent = left;
    node.updateSubtreeLength();
    left.updateSubtreeLength();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function createLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function createPrefixTable(text: string): number[] {
  const table = Array.from<number>({ length: text.length }).fill(0);
  let matched = 0;
  for (let i = 1; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    while (matched > 0 && charCode !== text.charCodeAt(matched)) {
      matched = table[matched - 1];
    }
    if (charCode === text.charCodeAt(matched)) {
      matched++;
    }
    table[i] = matched;
  }
  return table;
}

// Keeps the table compact after repeated edits by joining neighboring pieces
// that already point at contiguous text in the same backing buffer.
function coalescePieces(pieces: Piece[]): Piece[] {
  const coalescedPieces: Piece[] = [];
  for (const piece of pieces) {
    if (piece.length === 0) {
      continue;
    }

    const previous = coalescedPieces[coalescedPieces.length - 1];
    if (
      previous !== undefined &&
      previous.source === piece.source &&
      previous.offset + previous.length === piece.offset
    ) {
      coalescedPieces[coalescedPieces.length - 1] = {
        ...previous,
        length: previous.length + piece.length,
      };
      continue;
    }

    coalescedPieces.push(piece);
  }
  return coalescedPieces;
}

function lineFeedCount(segment: PieceSegment): number {
  return (
    upperBound(segment.lineOffsets, segment.end) -
    upperBound(segment.lineOffsets, segment.start)
  );
}

// Returns the index of the first element in the array that is greater than the target.
function upperBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (values[mid] <= target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}
