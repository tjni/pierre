const LINE_FEED = 10; // \n
const CARRIAGE_RETURN = 13; // \r

/**
 * Computes line start offsets plus a final end offset for slicing line text.
 * `lineCount` excludes the final newline-only parser row, except for files
 * that contain only that row.
 */
export function computeLineOffsets(contents: string): number[] {
  const offsets: number[] = [0];
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
  return offsets;
}
