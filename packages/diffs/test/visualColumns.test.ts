import { describe, expect, test } from 'bun:test';

import { getVisualColumn } from '../src/editor/visualColumns';

describe('getVisualColumn', () => {
  test('keeps plain text columns unchanged', () => {
    expect(getVisualColumn('hello', 0, 2)).toBe(0);
    expect(getVisualColumn('hello', 3, 2)).toBe(3);
    expect(getVisualColumn('hello', 99, 2)).toBe(5);
  });

  test('expands tabs to the configured tab size', () => {
    expect(getVisualColumn('\ta', 1, 2)).toBe(2);
    expect(getVisualColumn('\ta', 1, 4)).toBe(4);
    expect(getVisualColumn('\ta', 2, 2)).toBe(3);
  });

  test('aligns tab stops based on current visual column', () => {
    expect(getVisualColumn('a\tb', 2, 2)).toBe(2);
    expect(getVisualColumn('a\tb', 2, 4)).toBe(4);
    expect(getVisualColumn('ab\tc', 3, 4)).toBe(4);
    expect(getVisualColumn('abc\tz', 4, 4)).toBe(4);
  });
});
