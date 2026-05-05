import { describe, expect, test } from 'bun:test';

import type { LineAnnotation, RenderRange } from '../src/types';
import { hasVisibleLineAnnotation } from '../src/utils/hasVisibleLineAnnotation';

const annotations: LineAnnotation<string>[] = [
  { lineNumber: 1, metadata: 'first' },
  { lineNumber: 3, metadata: 'third' },
  { lineNumber: 5, metadata: 'fifth' },
];

function createRenderRange(
  startingLine: number,
  totalLines: number
): RenderRange {
  return {
    startingLine,
    totalLines,
    bufferBefore: 0,
    bufferAfter: 0,
  };
}

describe('hasVisibleLineAnnotation', () => {
  test('returns false when there are no annotations', () => {
    expect(hasVisibleLineAnnotation([], undefined)).toBe(false);
  });

  test('returns true for any annotation without a render range', () => {
    expect(hasVisibleLineAnnotation(annotations, undefined)).toBe(true);
  });

  test('matches annotations inside a zero-based render range', () => {
    expect(hasVisibleLineAnnotation(annotations, createRenderRange(2, 2))).toBe(
      true
    );
  });

  test('treats the render range end as exclusive', () => {
    expect(hasVisibleLineAnnotation(annotations, createRenderRange(1, 1))).toBe(
      false
    );
  });

  test('supports infinite render ranges', () => {
    expect(
      hasVisibleLineAnnotation(annotations, createRenderRange(3, Infinity))
    ).toBe(true);
  });
});
