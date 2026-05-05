import type { LineAnnotation, RenderRange } from '../types';

/**
 * Checks if any line annotations are visible within the given render range.
 * @param lineAnnotations - The array of line annotations to check.
 * @param renderRange - The render range to check against.
 * @returns True if any line annotations are visible, false otherwise.
 */
export function hasVisibleLineAnnotation<LAnnotation>(
  lineAnnotations: readonly LineAnnotation<LAnnotation>[],
  renderRange: RenderRange | undefined
): boolean {
  if (lineAnnotations.length === 0) {
    return false;
  }
  if (renderRange == null) {
    return true;
  }
  const { startingLine, totalLines } = renderRange;
  const endLine =
    totalLines === Infinity ? Infinity : startingLine + totalLines;
  return lineAnnotations.some((annotation) => {
    const lineIndex = annotation.lineNumber - 1;
    return lineIndex >= startingLine && lineIndex < endLine;
  });
}
