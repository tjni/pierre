import type { LineAnnotation } from '../types';
import type { TextDocumentChange } from './textDocument';

// Updates 1-based line annotations after the document has applied an edit,
// returning undefined when no annotation moved or was deleted.
export function applyDocumentChangeToLineAnnotations<T>(
  lastChange: TextDocumentChange,
  lineAnnotations: readonly LineAnnotation<T>[]
): LineAnnotation<T>[] | undefined {
  if (lastChange.lineDelta === 0) {
    return undefined;
  }

  const startCharacter = lastChange.startCharacter ?? 0;
  const removedLineCount = Math.max(0, -lastChange.lineDelta);
  const deletedStartLine =
    removedLineCount === 0
      ? undefined
      : lastChange.startLine + (startCharacter === 0 ? 0 : 1);
  const deletedEndLine =
    deletedStartLine === undefined
      ? undefined
      : deletedStartLine + removedLineCount;
  const shiftFromLine =
    removedLineCount > 0
      ? lastChange.startLine + removedLineCount
      : lastChange.startLine + (startCharacter === 0 ? 0 : 1);
  const nextLineAnnotations: LineAnnotation<T>[] = [];
  let changed = false;

  for (const annotation of lineAnnotations) {
    const line = annotation.lineNumber - 1;
    if (
      deletedStartLine !== undefined &&
      deletedEndLine !== undefined &&
      line >= deletedStartLine &&
      line < deletedEndLine
    ) {
      changed = true;
      continue;
    }

    if (line >= shiftFromLine) {
      nextLineAnnotations.push({
        ...annotation,
        lineNumber: line + lastChange.lineDelta + 1,
      });
      changed = true;
      continue;
    }

    nextLineAnnotations.push(annotation);
  }

  return changed ? nextLineAnnotations : undefined;
}
