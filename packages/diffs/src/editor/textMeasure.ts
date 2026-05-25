import { h } from './utils';

/** Check if the text needs DOM text measurement. */
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

/** snap the text offset to the Unicode boundary */
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
  // Avoid measuring a caret position inside one visual emoji/grapheme.
  // Browser caret movement can report offsets around UTF-16 surrogate
  // pairs and emoji joiners; measuring a partial sequence gives a
  // replacement-glyph width.
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

/** get the offsets of the Unicode grapheme clusters in the text */
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

/** measure the width of the text using the DOM */
export function measureDomTextWidth(
  text: string,
  parentElement: HTMLElement
): number {
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
    parentElement
  );
  try {
    return measureEl.getBoundingClientRect().width;
  } finally {
    measureEl.remove();
  }
}

/** get the number of columns of the ASCII text */
export function getExpandedAsciiTextColumns(
  text: string,
  tabSize: number
): number {
  let columns = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      return -1;
    }
    columns += text.charCodeAt(i) === /* '\t' */ 9 ? tabSize : 1;
  }
  return columns;
}
