import { describe, expect, test } from 'bun:test';

import { Editor } from '../src/editor/editor';
import type {
  DiffLineAnnotation,
  DiffsEditableComponent,
  DiffsEditor,
  DiffsHighlighter,
  DiffsTextDocument,
  FileContents,
  HighlightedToken,
} from '../src/types';
import { installDom } from './domHarness';

const TOTAL_LINES = 3_728;
const TARGET_LINE_NUMBER = 3_001;
const RENDERED_START_LINE_NUMBER = 3_401;
const RENDERED_END_LINE_NUMBER = 3_650;
const MODEL_LINE_HEIGHT = 20;
const EDITOR_LINE_HEIGHT = 22;
const TARGET_LINE_TOP = (TARGET_LINE_NUMBER - 1) * MODEL_LINE_HEIGHT;

function makeSourceLine(lineNumber: number): string {
  return `// source line ${lineNumber}`;
}

function createTestHighlighter(): DiffsHighlighter {
  return {
    getLoadedLanguages: () => [],
    getTheme: () => ({ colors: {} }),
    setTheme: () => ({ colorMap: [''] }),
  } as unknown as DiffsHighlighter;
}

class VirtualizedEditableComponent implements DiffsEditableComponent<undefined> {
  readonly type = 'file' as const;
  readonly top = 0;
  readonly fileContainer = document.createElement('div');
  options: DiffsEditableComponent<undefined>['options'] = {
    theme: 'github-light',
    themeType: 'light',
  };

  #editor?: DiffsEditor<undefined>;
  readonly #file: FileContents = {
    name: 'virtualized.ts',
    contents: Array.from({ length: TOTAL_LINES }, (_, lineIndex) =>
      makeSourceLine(lineIndex + 1)
    ).join('\n'),
    lang: 'text',
  };

  constructor() {
    document.body.appendChild(this.fileContainer);
    this.#renderShadowDom();
  }

  getLinePosition(
    lineNumber: number
  ): { top: number; height: number } | undefined {
    return lineNumber === TARGET_LINE_NUMBER
      ? { top: TARGET_LINE_TOP, height: MODEL_LINE_HEIGHT }
      : undefined;
  }

  setOptions(options: Partial<DiffsEditableComponent<undefined>['options']>) {
    this.options = { ...this.options, ...options };
  }

  setSelectedLines(_range: { start: number; end: number } | null): void {}

  render(): void {
    this.rerender();
  }

  rerender(): void {
    this.#renderShadowDom();
    this.#syncRenderView();
  }

  cleanUp(): void {
    this.#editor = undefined;
    this.fileContainer.remove();
  }

  attachEditor(editor: DiffsEditor<undefined>): () => void {
    this.#editor = editor;
    this.#syncRenderView();
    return () => {
      this.#editor = undefined;
    };
  }

  applyDocumentChange(
    _textDocument: DiffsTextDocument,
    _newLineAnnotations?: DiffLineAnnotation<undefined>[]
  ): void {}

  updateRenderCache(
    _lines: Map<number, Array<HighlightedToken>>,
    _themeType: 'dark' | 'light'
  ): void {}

  #syncRenderView(): void {
    this.#editor?.__syncRenderView(
      createTestHighlighter(),
      this.fileContainer,
      this.#file,
      undefined,
      {
        startingLine: RENDERED_START_LINE_NUMBER - 1,
        totalLines: RENDERED_END_LINE_NUMBER - RENDERED_START_LINE_NUMBER + 1,
        bufferBefore: 0,
        bufferAfter: 0,
      }
    );
  }

  #renderShadowDom(): void {
    const shadowRoot =
      this.fileContainer.shadowRoot ??
      this.fileContainer.attachShadow({ mode: 'open' });
    shadowRoot.replaceChildren();

    const code = document.createElement('div');
    code.dataset.code = '';

    const content = document.createElement('div');
    content.dataset.content = '';
    content.style.lineHeight = EDITOR_LINE_HEIGHT + 'px';

    for (
      let lineNumber = RENDERED_START_LINE_NUMBER;
      lineNumber <= RENDERED_END_LINE_NUMBER;
      lineNumber++
    ) {
      const line = document.createElement('div');
      line.dataset.line = String(lineNumber);
      line.dataset.lineIndex = String(lineNumber - 1);
      line.dataset.lineType = 'context';
      line.textContent = makeSourceLine(lineNumber);
      content.appendChild(line);
    }

    code.appendChild(content);
    shadowRoot.appendChild(code);
  }
}

describe('Editor virtualized reveal', () => {
  test('keeps using model geometry while an offscreen line rerenders', () => {
    const dom = installDom();
    const scrollTops: number[] = [];
    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) {
        const top = Number.parseFloat(this.style.top);
        if (Number.isFinite(top)) {
          scrollTops.push(top);
        }
      },
    });

    const editor = new Editor<undefined>();
    const component = new VirtualizedEditableComponent();

    try {
      editor.edit(component);
      editor.setSelections([
        {
          start: { line: TARGET_LINE_NUMBER - 1, character: 0 },
          end: { line: TARGET_LINE_NUMBER - 1, character: 0 },
          direction: 'none',
        },
      ]);

      // This models the production repro: the virtual model estimates 20px
      // lines while the editor measures 22px, and line 3,001 remains offscreen
      // as lines 3,401 through 3,650 render. Both reveal attempts should use the
      // target's stable position in the virtual model.
      component.rerender();

      expect(scrollTops).toEqual([TARGET_LINE_TOP, TARGET_LINE_TOP]);
    } finally {
      editor.cleanUp();
      component.cleanUp();
      dom.cleanup();
    }
  });
});
