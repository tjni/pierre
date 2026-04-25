import { type EditorSelection, type EditorTextChange } from './editorSelection';
import type { TextDocument } from './textDocument';

export interface TextareaSnapshot {
  readonly startLine: number;
  readonly offset: number;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly lines: number;
  readonly text: string;
}

export function createTextareaSnapshot(
  textDocument: TextDocument,
  primarySelection: EditorSelection
): TextareaSnapshot {
  const startLine = Math.max(0, primarySelection.start.line - 1);
  const endLine = Math.min(
    textDocument.lineCount - 1,
    primarySelection.end.line + 1
  );
  const lines: string[] = [];
  let offset = 0;
  let selectionStart = 0;
  let selectionEnd = 0;

  for (let line = startLine; line <= endLine; line++) {
    const lineText = textDocument.getLineText(line);
    if (lineText === undefined) {
      throw new Error(`Line ${line} is out of bounds`);
    }
    if (line === primarySelection.start.line) {
      selectionStart = offset + primarySelection.start.character;
    }
    if (line === primarySelection.end.line) {
      selectionEnd = offset + primarySelection.end.character;
    }
    lines.push(lineText);
    offset += lineText.length;
    if (line < endLine) {
      offset++;
    }
  }

  return {
    startLine,
    offset: textDocument.offsetAt({ line: startLine, character: 0 }),
    selectionStart,
    selectionEnd,
    lines: lines.length,
    text: lines.join('\n'),
  };
}

export function resolveTextChange(
  textareaSnapshot: TextareaSnapshot,
  newView: string
): EditorTextChange {
  const original = textareaSnapshot.text;
  const originalLength = original.length;
  const nextLength = newView.length;

  let prefix = 0;
  while (
    prefix < originalLength &&
    prefix < nextLength &&
    original[prefix] === newView[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < originalLength - prefix &&
    suffix < nextLength - prefix &&
    original[originalLength - 1 - suffix] === newView[nextLength - 1 - suffix]
  ) {
    suffix++;
  }

  const originalStart = prefix;
  const originalEnd = originalLength - suffix;

  return {
    start: textareaSnapshot.offset + originalStart,
    end: textareaSnapshot.offset + originalEnd,
    text: newView.slice(prefix, nextLength - suffix),
  };
}
