import { describe, expect, test } from 'bun:test';

import { coalesceMicrotask } from '../src/editor/editorUtils';

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
