import { type EditorSelection, SelectionDirection } from './editorSelection';
import type { Position, ResolvedTextEdit, TextDocument } from './textDocument';

export interface TextareaSnapshot {
  startLine: number;
  offset: number;
  selectionStart: number;
  selectionEnd: number;
  text: string;
  lineCount: number;
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

  const startCharacter = normalizeCharacterForDocument(
    textDocument,
    primarySelection.start
  );
  const endCharacter = normalizeCharacterForDocument(
    textDocument,
    primarySelection.end
  );

  for (let line = startLine; line <= endLine; line++) {
    const lineText = textDocument.getLineText(line);
    if (line === primarySelection.start.line) {
      selectionStart = offset + startCharacter;
    }
    if (line === primarySelection.end.line) {
      selectionEnd = offset + endCharacter;
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
    text: lines.join('\n'),
    lineCount: lines.length,
  };
}

export function resolveTextareaChange(
  textareaSnapshot: TextareaSnapshot,
  newView: string,
  selectionStart: number,
  selectionEnd: number
): ResolvedTextEdit {
  const original = textareaSnapshot.text;
  const originalLength = original.length;
  const nextLength = newView.length;

  if (
    selectionStart === selectionEnd &&
    textareaSnapshot.selectionStart === textareaSnapshot.selectionEnd
  ) {
    const lengthDelta = nextLength - originalLength;
    const start = selectionStart - Math.max(lengthDelta, 0);
    const end = start + Math.max(-lengthDelta, 0);
    const text = newView.slice(start, selectionStart);
    if (
      lengthDelta !== 0 &&
      start >= 0 &&
      end <= originalLength &&
      original.slice(0, start) + text + original.slice(end) === newView
    ) {
      return {
        start: textareaSnapshot.offset + start,
        end: textareaSnapshot.offset + end,
        text,
      };
    }
  }

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

export function getSelectionDirectionFromTextarea(
  textareaEl: HTMLTextAreaElement
): SelectionDirection {
  return textareaEl.selectionDirection === 'backward'
    ? SelectionDirection.Backward
    : SelectionDirection.Forward;
}

export function toTextareaSelectionDirection(
  selection: EditorSelection
): HTMLTextAreaElement['selectionDirection'] {
  switch (selection.direction) {
    case SelectionDirection.Backward:
      return 'backward';
    case SelectionDirection.Forward:
      return 'forward';
    case SelectionDirection.None:
      return 'none';
  }
}

/** Aligns a column with `TextDocument.offsetAt` / `positionAt` so textarea indices match backing text (DOM may report past end for empty lines that render a placeholder space). */
function normalizeCharacterForDocument(
  textDocument: TextDocument,
  position: Position
): number {
  return textDocument.positionAt(textDocument.offsetAt(position)).character;
}
