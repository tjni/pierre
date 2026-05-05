import { describe, expect, test } from 'bun:test';

import { applyDocumentChangeToLineAnnotations } from '../src/editor/editorLineAnnotations';
import { TextDocument } from '../src/editor/textDocument';
import type { LineAnnotation } from '../src/types';

describe('applyDocumentChangeToLineAnnotations', () => {
  test('deletes annotations attached to deleted lines', () => {
    const textDocument = new TextDocument('inmemory://1', 'one\ntwo\nthree');
    const annotations: LineAnnotation<string>[] = [
      { lineNumber: 1, metadata: 'one' },
      { lineNumber: 2, metadata: 'two' },
      { lineNumber: 3, metadata: 'three' },
    ];

    textDocument.applyEdits([
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 2, character: 0 },
        },
        newText: '',
      },
    ]);

    expect(
      applyDocumentChangeToLineAnnotations(
        textDocument.lastChange!,
        annotations
      )
    ).toEqual([
      { lineNumber: 1, metadata: 'one' },
      { lineNumber: 2, metadata: 'three' },
    ]);
  });

  test('moves annotations down when lines are inserted above them', () => {
    const textDocument = new TextDocument('inmemory://1', 'one\ntwo\nthree');
    const annotations: LineAnnotation<string>[] = [
      { lineNumber: 1, metadata: 'one' },
      { lineNumber: 2, metadata: 'two' },
      { lineNumber: 3, metadata: 'three' },
    ];

    textDocument.applyEdits([
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 0 },
        },
        newText: 'inserted\n',
      },
    ]);

    expect(
      applyDocumentChangeToLineAnnotations(
        textDocument.lastChange!,
        annotations
      )
    ).toEqual([
      { lineNumber: 1, metadata: 'one' },
      { lineNumber: 3, metadata: 'two' },
      { lineNumber: 4, metadata: 'three' },
    ]);
  });

  test('returns null when annotations do not move', () => {
    const textDocument = new TextDocument('inmemory://1', 'one\ntwo\nthree');
    const annotations: LineAnnotation<string>[] = [
      { lineNumber: 1, metadata: 'one' },
    ];

    textDocument.applyEdits([
      {
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 0 },
        },
        newText: 'inserted\n',
      },
    ]);

    expect(
      applyDocumentChangeToLineAnnotations(
        textDocument.lastChange!,
        annotations
      )
    ).toBe(undefined);
  });
});
