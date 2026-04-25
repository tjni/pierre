import { describe, expect, test } from 'bun:test';

import { getVisualColumns } from '../src/editor/visualColumns';

describe('getVisualColumn', () => {
  test('keeps plain text columns unchanged', () => {
    expect(getVisualColumns('hello', 0, 2)).toBe(0);
    expect(getVisualColumns('hello', 3, 2)).toBe(3);
    expect(getVisualColumns('hello', 99, 2)).toBe(5);
  });

  test('expands tabs to the configured tab size', () => {
    expect(getVisualColumns('\ta', 1, 2)).toBe(2);
    expect(getVisualColumns('\ta', 1, 4)).toBe(4);
    expect(getVisualColumns('\ta', 2, 2)).toBe(3);
  });

  test('aligns tab stops based on current visual column', () => {
    expect(getVisualColumns('a\tb', 2, 2)).toBe(2);
    expect(getVisualColumns('a\tb', 2, 4)).toBe(4);
    expect(getVisualColumns('ab\tc', 3, 4)).toBe(4);
    expect(getVisualColumns('abc\tz', 4, 4)).toBe(4);
  });
});
