import type { FileContentsWithLineOffsets } from '../types';

/**
 * Gets the text of a line in a file.
 * @param file - The file to get the text of.
 * @param lineIndex - The index of the line to get the text of.
 * @returns The text of the line.
 */
export function getLineText(
  file: FileContentsWithLineOffsets,
  lineIndex: number
): string {
  if (lineIndex < 0 || lineIndex >= file.lineCount) {
    throw new Error(`Line index out of range: ${lineIndex}`);
  }
  return file.contents.slice(
    file.offsets[lineIndex],
    file.offsets[lineIndex + 1] ?? file.contents.length
  );
}
