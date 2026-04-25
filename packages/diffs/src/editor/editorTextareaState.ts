import {
  type EditorSelection,
  fromWebSelectionDirection,
} from './editorSelection';
import { getLineIndentation } from './editorUtils';

export type TextareaState = {
  selections: EditorSelection[];
  primarySelection: EditorSelection;
  snippet: TextareaSnippet;
  value: string;
};

type TextLineSource = {
  lineCount: number;
  getLineText(line: number): string | undefined;
};

interface TextareaSnippet {
  firstLine: number;
  lastLine: number;
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

type TextareaTextChange = {
  start: number;
  end: number;
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

type ResolveTextareaTextChangeOptions = {
  documentValue?: string;
  originalValue: string;
  value: string;
  originalSelectionStart: number;
  originalSelectionEnd: number;
  selectionStart: number;
  selectionEnd: number;
};

type TextareaSnapshot = Pick<
  HTMLTextAreaElement,
  'value' | 'selectionStart' | 'selectionEnd' | 'selectionDirection'
>;

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

function detectIndentUnit(text: string): string {
  const lines = text.split('\n');
  const spaceIndentLengths: number[] = [];
  let tabIndentedLineCount = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    const indentation = getLineIndentation(line);
    if (indentation === '') {
      continue;
    }
    if (indentation.startsWith('\t')) {
      tabIndentedLineCount++;
      continue;
    }
    spaceIndentLengths.push(indentation.length);
  }
  if (spaceIndentLengths.length > 0) {
    const unitLength = spaceIndentLengths.reduce((acc, length) =>
      gcd(acc, length)
    );
    if (unitLength > 1) {
      return ' '.repeat(unitLength);
    }
    return ' '.repeat(Math.min(...spaceIndentLengths));
  }
  if (tabIndentedLineCount > 0) {
    return '\t';
  }
  return '  ';
}

export function createTextareaSnippet(
  textLineSource: TextLineSource,
  selection: EditorSelection
): TextareaSnippet {
  const firstLine = Math.max(0, selection.start.line - 1);
  const lastLine = Math.min(
    textLineSource.lineCount - 1,
    selection.end.line + 1
  );
  const lines: string[] = [];
  let offset = 0;
  let selectionStart = 0;
  let selectionEnd = 0;

  for (let line = firstLine; line <= lastLine; line++) {
    const lineText = textLineSource.getLineText(line);
    if (lineText === undefined) {
      throw new Error(`Line ${line} is out of bounds`);
    }
    if (line === selection.start.line) {
      selectionStart = offset + selection.start.character;
    }
    if (line === selection.end.line) {
      selectionEnd = offset + selection.end.character;
    }
    lines.push(lineText);
    offset += lineText.length;
    if (line < lastLine) {
      offset++;
    }
  }

  return {
    firstLine,
    lastLine,
    text: lines.join('\n'),
    selectionStart,
    selectionEnd,
  };
}

export function matchesTextareaState(
  textareaState: TextareaState,
  { value, selectionStart, selectionEnd, selectionDirection }: TextareaSnapshot
): boolean {
  return (
    value === textareaState.value &&
    selectionStart === textareaState.snippet.selectionStart &&
    selectionEnd === textareaState.snippet.selectionEnd &&
    fromWebSelectionDirection(selectionDirection) ===
      textareaState.primarySelection.direction
  );
}

export function resolveTextareaTextChange({
  documentValue,
  originalValue,
  value,
  originalSelectionStart,
  originalSelectionEnd,
  selectionStart,
  selectionEnd,
}: ResolveTextareaTextChangeOptions): TextareaTextChange {
  let prefixLength = 0;
  const prefixLimit = Math.min(originalSelectionStart, selectionStart);
  while (
    prefixLength < prefixLimit &&
    originalValue[prefixLength] === value[prefixLength]
  ) {
    prefixLength++;
  }

  let suffixLength = 0;
  const suffixLimit = Math.min(
    originalValue.length - originalSelectionEnd,
    value.length - selectionEnd
  );
  while (
    suffixLength < suffixLimit &&
    originalValue[originalValue.length - 1 - suffixLength] ===
      value[value.length - 1 - suffixLength]
  ) {
    suffixLength++;
  }

  const start = prefixLength;
  const end = originalValue.length - suffixLength;
  let text = value.slice(prefixLength, value.length - suffixLength);
  let nextSelectionStart = selectionStart;
  let nextSelectionEnd = selectionEnd;
  const getLineBounds = (offset: number) => {
    const lineStart =
      originalValue.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const lineEnd = originalValue.indexOf('\n', offset);
    return {
      lineStart,
      lineEnd: lineEnd === -1 ? originalValue.length : lineEnd,
    };
  };

  if (
    originalSelectionStart === originalSelectionEnd &&
    selectionStart === selectionEnd &&
    text === '\n' &&
    end === start
  ) {
    const { lineStart, lineEnd } = getLineBounds(start);
    const lineText = originalValue.slice(lineStart, lineEnd);
    const indentation = getLineIndentation(lineText);
    if (indentation.length > 0) {
      text += indentation;
      const delta = indentation.length;
      nextSelectionStart += delta;
      nextSelectionEnd += delta;
    }
  }

  if (
    originalSelectionStart === originalSelectionEnd &&
    selectionStart === selectionEnd &&
    text === '' &&
    end - start === 1 &&
    selectionStart === originalSelectionStart - 1
  ) {
    const { lineStart, lineEnd } = getLineBounds(originalSelectionStart);
    const lineText = originalValue.slice(lineStart, lineEnd);
    const indentation = getLineIndentation(lineText);
    if (
      indentation.length > 0 &&
      indentation.length === lineText.length &&
      end === lineEnd
    ) {
      const indentUnit = detectIndentUnit(documentValue ?? originalValue);
      const deletedIndentLength = indentation.startsWith('\t')
        ? 1
        : Math.min(
            indentUnit === '\t' ? 1 : indentUnit.length,
            indentation.length
          );
      const expandedStart = Math.max(lineStart, end - deletedIndentLength);
      const delta = start - expandedStart;
      if (delta > 0) {
        nextSelectionStart -= delta;
        nextSelectionEnd -= delta;
      }
      return {
        start: expandedStart,
        end,
        text,
        selectionStart: nextSelectionStart,
        selectionEnd: nextSelectionEnd,
      };
    }
  }

  return {
    start,
    end,
    text,
    selectionStart: nextSelectionStart,
    selectionEnd: nextSelectionEnd,
  };
}
