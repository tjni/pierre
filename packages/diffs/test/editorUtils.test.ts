import { describe, expect, test } from 'bun:test';

import { coalesceMicrotask, parseCssValue } from '../src/editor/editorUtils';

describe('parseCssValue', () => {
  const cases: Array<[string, [number, string]]> = [
    ['abc', [0, '']],
    ['14', [14, '']],
    ['1.5', [1.5, '']],
    ['14px', [14, 'px']],
    ['1.25rem', [1.25, 'rem']],
    ['-2em', [-2, 'em']],
  ];

  test.each(cases)('parses %p as %p', (value, expected) => {
    expect(parseCssValue(value)).toEqual(expected);
  });
});

describe('coalesceMicrotask', () => {
  test('runs once for repeated calls in the same tick', async () => {
    let callCount = 0;
    const run = coalesceMicrotask(() => {
      callCount++;
    });

    run();
    run();
    run();
    expect(callCount).toBe(0);

    await Promise.resolve();
    expect(callCount).toBe(1);
  });

  test('allows a later tick to run again', async () => {
    let callCount = 0;
    const run = coalesceMicrotask(() => {
      callCount++;
    });

    run();
    await Promise.resolve();
    run();
    await Promise.resolve();

    expect(callCount).toBe(2);
  });
});
