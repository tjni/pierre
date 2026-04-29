import { describe, expect, test } from 'bun:test';

import { computeLineOffsets } from '../src/utils/computeFileOffsets';
import { getLineText } from '../src/utils/getLineText';

describe('computeLineOffsets', () => {
  test('returns no offsets for empty contents', () => {
    const result = computeLineOffsets({
      name: 'empty.ts',
      contents: '',
    });

    expect(result.offsets).toEqual([]);
    expect(result.lineCount).toBe(0);
  });

  test('computes offsets for single line without trailing newline', () => {
    const result = computeLineOffsets({
      name: 'single.ts',
      contents: 'hello',
    });

    expect(result.offsets).toEqual([0, 5]);
    expect(result.lineCount).toBe(1);
  });

  test('computes offsets for LF files with and without terminal newline', () => {
    const withTerminalNewline = computeLineOffsets({
      name: 'lf-terminal.ts',
      contents: 'a\nb\n',
    });
    const withoutTerminalNewline = computeLineOffsets({
      name: 'lf-no-terminal.ts',
      contents: 'a\nb',
    });

    expect(withTerminalNewline.offsets).toEqual([0, 2, 4]);
    expect(withTerminalNewline.lineCount).toBe(2);
    expect(withoutTerminalNewline.offsets).toEqual([0, 2, 3]);
    expect(withoutTerminalNewline.lineCount).toBe(2);
  });

  test('computes offsets for CRLF and lone CR line endings', () => {
    const crlf = computeLineOffsets({
      name: 'crlf.ts',
      contents: 'a\r\nb\r\n',
    });
    const mixed = computeLineOffsets({
      name: 'mixed.ts',
      contents: 'a\rb\r\nc\n',
    });

    expect(crlf.offsets).toEqual([0, 3, 6]);
    expect(crlf.lineCount).toBe(2);
    expect(mixed.offsets).toEqual([0, 2, 5, 7]);
    expect(mixed.lineCount).toBe(3);
  });
});

describe('getLineText', () => {
  test('returns line text using computed offsets', () => {
    const lines = computeLineOffsets({
      name: 'lines.ts',
      contents: 'first\nsecond\nthird',
    });

    expect(getLineText(lines, 0)).toBe('first\n');
    expect(getLineText(lines, 1)).toBe('second\n');
    expect(getLineText(lines, 2)).toBe('third');
  });

  test('throws when line index is outside valid range', () => {
    const lines = computeLineOffsets({
      name: 'bounds.ts',
      contents: 'line',
    });

    expect(() => getLineText(lines, -1)).toThrow('Line index out of range: -1');
    expect(() => getLineText(lines, lines.lineCount)).toThrow(
      `Line index out of range: ${lines.lineCount}`
    );
  });
});
