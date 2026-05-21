import { h } from './utils';

export function needsDomTextMeasurement(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0x200d ||
      code === 0xfe0e ||
      code === 0xfe0f
    ) {
      return true;
    }
  }
  return false;
}

// Avoid measuring a caret position inside one visual emoji/grapheme. Browser
// caret movement can report offsets around UTF-16 surrogate pairs and emoji
// joiners; measuring a partial sequence gives a replacement-glyph width.
export function snapTextOffsetToUnicodeBoundary(
  text: string,
  offset: number
): number {
  const boundedOffset = Math.max(0, Math.min(offset, text.length));
  if (
    boundedOffset === 0 ||
    boundedOffset === text.length ||
    !needsDomTextMeasurement(text)
  ) {
    return boundedOffset;
  }
  const segmenter = new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  });
  for (const segment of segmenter.segment(text)) {
    const segmentStart = segment.index;
    const segmentEnd = segmentStart + segment.segment.length;
    if (boundedOffset > segmentStart && boundedOffset < segmentEnd) {
      return segmentEnd;
    }
    if (boundedOffset <= segmentStart) {
      break;
    }
  }
  return boundedOffset;
}

export function getUnicodeMeasurementOffsets(
  text: string
): number[] | undefined {
  if (!needsDomTextMeasurement(text)) {
    return undefined;
  }
  const offsets = [0];
  const segmenter = new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  });
  for (const segment of segmenter.segment(text)) {
    offsets.push(segment.index + segment.segment.length);
  }
  return offsets;
}

export function measureDomTextWidth(
  text: string,
  containerElement: HTMLElement | undefined,
  measureCtx: CanvasRenderingContext2D | undefined
): number {
  if (containerElement === undefined || measureCtx === undefined) {
    return measureCtx?.measureText(text).width ?? 0;
  }
  const measureEl = h(
    'span',
    {
      style: {
        position: 'absolute',
        top: '0',
        left: '0',
        visibility: 'hidden',
        pointerEvents: 'none',
        whiteSpace: 'pre',
        font: 'inherit',
      },
      textContent: text,
    },
    containerElement
  );
  try {
    return measureEl.getBoundingClientRect().width;
  } finally {
    measureEl.remove();
  }
}
