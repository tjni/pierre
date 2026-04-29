import type { FileContents, FileContentsWithLineOffsets } from '../types';

const LINE_FEED = 10; // \n
const CARRIAGE_RETURN = 13; // \r

/**
 * Computes the start offset of each renderable line plus a final end offset.
 * A terminal newline remains part of the previous line, matching splitFileContents.
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
  return {
    ...file,
    offsets,
    lineCount: offsets.length - 1,
  };
}
