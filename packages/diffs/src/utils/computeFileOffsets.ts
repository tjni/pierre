import type { FileContents, FileContentsWithLineOffsets } from '../types';

const LINE_FEED = 10; // \n
const CARRIAGE_RETURN = 13; // \r

/**
 * Computes line start offsets plus a final end offset for slicing line text.
 * `lineCount` excludes the final newline-only parser row, except for files
 * that contain only that row.
 */
export function computeLineOffsets(
  file: FileContents
): FileContentsWithLineOffsets {
  const { contents } = file;
  const offsets = [];
  if (contents.length > 0) {
    offsets.push(0);
  }
  for (let i = 0; i < contents.length; i++) {
    const char = contents.charCodeAt(i);
    if (char === LINE_FEED || char === CARRIAGE_RETURN) {
      if (
        char === CARRIAGE_RETURN &&
        i + 1 < contents.length &&
        contents.charCodeAt(i + 1) === LINE_FEED
      ) {
        i++;
      }
      offsets.push(i + 1);
    }
  }
  if (offsets.length > 0 && offsets[offsets.length - 1] !== contents.length) {
    offsets.push(contents.length);
  }
  const rawLineCount = Math.max(0, offsets.length - 1);
  const lineCount =
    rawLineCount > 1 &&
    isNewlineOnlyRange(
      contents,
      offsets[rawLineCount - 1],
      offsets[rawLineCount]
    )
      ? rawLineCount - 1
      : rawLineCount;

  return {
    ...file,
    offsets,
    lineCount,
  };
}

// Detects the synthetic final row produced by terminal newline characters.
function isNewlineOnlyRange(
  contents: string,
  startOffset = contents.length,
  endOffset = contents.length
): boolean {
  for (let offset = startOffset; offset < endOffset; offset++) {
    const char = contents.charCodeAt(offset);
    if (char !== LINE_FEED && char !== CARRIAGE_RETURN) {
      return false;
    }
  }
  return true;
}
