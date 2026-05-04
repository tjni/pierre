import { describe, expect, test } from 'bun:test';

import { computeLineOffsets } from '../src/utils/computeFileOffsets';

describe('computeLineOffsets', () => {
  test('returns a single start offset for empty contents', () => {
    const result = computeLineOffsets('');

    expect([...result]).toEqual([0]);
    expect(result.length).toBe(1);
  });

  test('computes offsets for single line without trailing newline', () => {
    const result = computeLineOffsets('hello');

    expect([...result]).toEqual([0, 5]);
    expect(result.length).toBe(2);
  });

  test('computes offsets for LF files with and without terminal newline', () => {
    const withTerminalNewline = computeLineOffsets('a\nb\n');
    const withoutTerminalNewline = computeLineOffsets('a\nb');

    expect([...withTerminalNewline]).toEqual([0, 2, 4]);
    expect(withTerminalNewline.length).toBe(3);
    expect([...withoutTerminalNewline]).toEqual([0, 2, 3]);
    expect(withoutTerminalNewline.length).toBe(3);
  });

  test('computes offsets for CRLF and lone CR line endings', () => {
    const crlf = computeLineOffsets('a\r\nb\r\n');
    const mixed = computeLineOffsets('a\rb\r\nc\n');

    expect([...crlf]).toEqual([0, 3, 6]);
    expect(crlf.length).toBe(3);
    expect([...mixed]).toEqual([0, 2, 5, 7]);
    expect(mixed.length).toBe(4);
  });
});

describe('renderable line count', () => {
  test('counts row slots including end offset for two lines without terminal newline', () => {
    const lines = computeLineOffsets('first\nsecond');

    expect(lines.length).toBe(3);
  });

  test('includes trailing blank line segment in offset array length', () => {
    const lines = computeLineOffsets('first\nsecond\n\n');

    expect([...lines]).toEqual([0, 6, 13, 14]);
    expect(lines.length).toBe(4);
  });

  test('treats newline-only contents as two offset boundaries', () => {
    const lines = computeLineOffsets('\n');

    expect(lines.length).toBe(2);
  });
});
