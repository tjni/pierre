import { describe, expect, test } from 'bun:test';

import { computeLineOffsets } from '../src/utils/computeFileOffsets';

describe('computeLineOffsets', () => {
  test('returns no offsets for empty contents', () => {
    const result = computeLineOffsets('');

    expect(result.offsets).toEqual([]);
    expect(result.lineCount).toBe(0);
  });

  test('computes offsets for single line without trailing newline', () => {
    const result = computeLineOffsets('hello');

    expect(result.offsets).toEqual([0, 5]);
    expect(result.lineCount).toBe(1);
  });

  test('computes offsets for LF files with and without terminal newline', () => {
    const withTerminalNewline = computeLineOffsets('a\nb\n');
    const withoutTerminalNewline = computeLineOffsets('a\nb');

    expect(withTerminalNewline.offsets).toEqual([0, 2, 4]);
    expect(withTerminalNewline.lineCount).toBe(2);
    expect(withoutTerminalNewline.offsets).toEqual([0, 2, 3]);
    expect(withoutTerminalNewline.lineCount).toBe(2);
  });

  test('computes offsets for CRLF and lone CR line endings', () => {
    const crlf = computeLineOffsets('a\r\nb\r\n');
    const mixed = computeLineOffsets('a\rb\r\nc\n');

    expect(crlf.offsets).toEqual([0, 3, 6]);
    expect(crlf.lineCount).toBe(2);
    expect(mixed.offsets).toEqual([0, 2, 5, 7]);
    expect(mixed.lineCount).toBe(3);
  });
});

describe('renderable line count', () => {
  test('keeps regular final lines', () => {
    const lines = computeLineOffsets('first\nsecond');

    expect(lines.lineCount).toBe(2);
  });

  test('excludes one final newline-only row from multi-line files', () => {
    const lines = computeLineOffsets('first\nsecond\n\n');

    expect(lines.offsets).toEqual([0, 6, 13, 14]);
    expect(lines.lineCount).toBe(2);
  });

  test('keeps a newline-only row when it is the whole file', () => {
    const lines = computeLineOffsets('\n');

    expect(lines.lineCount).toBe(1);
  });
});
