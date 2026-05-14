import { type IGrammar, INITIAL, type StateStack } from 'shiki/textmate';

import type { File } from '../components/File';
import { DEFAULT_THEMES } from '../constants';
import {
  type EditorCommand,
  resolveEditorCommandFromKeyboardEvent,
} from '../editor/editorCommand';
import type { EditorSelection } from '../editor/editorSelection';
import {
  applyTextChangeToSelections,
  applyTextReplaceToSelections,
  comparePosition,
  convertSelection,
  createSelectionFrom,
  DirectionBackward,
  DirectionForward,
  DirectionNone,
  expandCollapsedSelectionToWord,
  extendSelection,
  findNexMatch,
  getDocumentBoundarySelection,
  getDocumentFullSelection,
  getSelectionAnchor,
  getSelectionText,
  isCollapsedSelection,
  mapCursorMove,
  mapSelectionShift,
  resolveIndentEdits,
  selectionIntersects,
} from '../editor/editorSelection';
import {
  addEventListener,
  createElement,
  debounce,
  extend,
  round,
} from '../editor/editorUtils';
import {
  TextDocument,
  type TextDocumentChange,
  type TextEdit,
} from '../editor/textDocument';
import { getHighlighterIfLoaded } from '../highlighter/shared_highlighter';
import { areThemesAttached } from '../highlighter/themes/areThemesAttached';
import type {
  DiffsEditableComponent,
  DiffsEditor,
  DiffsEditorSelection,
  DiffsHighlighter,
  FileContents,
  HighlightedToken,
  LineAnnotation,
  RenderRange,
} from '../types';
import { getFiletypeFromFileName } from '../utils/getFiletypeFromFileName';
import {
  EDITOR_CSS,
  TOKENIZE_MAX_LINE_LENGTH,
  TOKENIZE_TIME_LIMIT,
} from './constants';
import { applyDocumentChangeToLineAnnotations } from './editorLineAnnotations';
import { isPrimaryModifier } from './platform';
import { BackgroundTokenizer, tokenizeLine } from './tokenzier';

export class Editor<LAnnotation> implements DiffsEditor<LAnnotation> {
  #disposes?: (() => void)[];
  #onChange?: (
    file: FileContents,
    lineAnnotations?: LineAnnotation<LAnnotation>[]
  ) => void;

  // css properties
  #charWidth = -1;
  #lineHeight = 20;
  #tabSize = 2;
  #wrap = false;

  // file
  #component?: DiffsEditableComponent<LAnnotation>;
  #fileContents?: FileContents;
  #lineAnnotations?: LineAnnotation<LAnnotation>[];
  #textDocument?: TextDocument<LAnnotation>;

  // highlighter
  #highlighter?: DiffsHighlighter;
  #currentTheme?: string;
  #colorMap?: string[];
  #renderRange?: RenderRange;
  #backgroundTokenizer?: BackgroundTokenizer;

  // cache
  #stateStackCache?: StateStack[];
  #lineYCache = new Map<number, number>();
  #wrapLineOffsetsCache = new Map<number, Uint32Array>();
  #lastCharX?: [line: number, character: number, x: number, wrapLine: number];

  // dom elements
  #fileContainer?: HTMLElement;
  #contentElement?: HTMLElement;
  #contentElementDisposes?: (() => void)[];
  #styleElement?: HTMLStyleElement;
  #overlayElement?: HTMLElement;
  #selectionElements?: Map<string, HTMLElement>;
  #primaryCaretElement?: HTMLElement;
  #measureCtx?: CanvasRenderingContext2D;
  #contentResizeObserver?: ResizeObserver;
  #lastContentWidth = -1;

  // state
  #shouldIgnoreSelectionChange = false;
  #isMouseDown = false;
  #shiftKeyPressed = false;
  #selectionStart: EditorSelection | undefined;
  #reservedSelections?: EditorSelection[];
  #selections?: EditorSelection[];
  #ensureScrollToLine?: number;

  #prebuildStateStackCache = debounce(async () => {
    const textDocument = this.#textDocument;
    const highlighter = this.#highlighter;
    if (textDocument === undefined || highlighter === undefined) {
      return;
    }

    if (!highlighter.getLoadedLanguages().includes(textDocument.languageId)) {
      await highlighter.loadLanguage(textDocument.languageId);
    }

    const grammar = highlighter.getLanguage(textDocument.languageId);
    if (grammar === undefined) {
      return;
    }

    const { startingLine = 0, totalLines = Infinity } = this.#renderRange ?? {};
    const endLine = Math.min(
      totalLines === Infinity ? Infinity : startingLine + totalLines,
      textDocument.lineCount
    );

    this.#buildStateStackCache(textDocument, grammar, endLine);
  }, 500);

  #emitChange = debounce(
    (
      fileContents: FileContents,
      lineAnnotations?: LineAnnotation<LAnnotation>[]
    ) => {
      this.#onChange?.(fileContents, lineAnnotations);
    },
    500
  );

  edit(
    component: DiffsEditableComponent<LAnnotation>,
    onChange?: (
      file: FileContents,
      lineAnnotations?: LineAnnotation<LAnnotation>[]
    ) => void
  ): () => void {
    this.#component = component;
    this.#onChange = onChange;
    this.#initialize();
    if (component.options.useTokenTransformer !== true) {
      // Tell the component to use token transformer that adds
      // `data-char` attribute to the tokens
      component.options.useTokenTransformer = true;
      component.setOptions(component.options);
      component.rerender();
    }
    component.setEditor(this);
    return () => this.cleanUp();
  }

  setSelections(selections: DiffsEditorSelection[]): void {
    const textDocument = this.#textDocument;
    if (textDocument !== undefined) {
      const resolvedSelections = selections.map<EditorSelection>(
        (selection) => {
          const start = textDocument.normalizePosition(selection.start);
          const end = textDocument.normalizePosition(selection.end);
          const direction =
            selection.direction === 'none'
              ? DirectionNone
              : selection.direction === 'backward'
                ? DirectionBackward
                : DirectionForward;
          return { direction, start, end };
        }
      );
      this.#updateSelections(resolvedSelections, true);
      this.#contentElement?.focus();
    }
  }

  cleanUp(): void {
    this.#disposes?.forEach((dispose) => dispose());
    this.#disposes = undefined;
    this.#onChange = undefined;

    this.#component?.setSelectedLines(null);
    this.#component?.removeEditor();
    this.#component = undefined;
    this.#fileContents = undefined;
    this.#lineAnnotations = undefined;
    this.#textDocument = undefined;

    this.#highlighter = undefined;
    this.#currentTheme = undefined;
    this.#colorMap = undefined;
    this.#renderRange = undefined;
    this.#backgroundTokenizer?.stop();
    this.#backgroundTokenizer = undefined;

    this.#stateStackCache = undefined;
    this.#lineYCache.clear();
    this.#wrapLineOffsetsCache.clear();
    this.#lastCharX = undefined;

    this.#fileContainer = undefined;
    this.#contentElement?.removeAttribute('contentEditable');
    this.#contentElement = undefined;
    this.#contentElementDisposes?.forEach((dispose) => dispose());
    this.#contentElementDisposes = undefined;
    this.#styleElement?.remove();
    this.#styleElement = undefined;
    this.#overlayElement?.remove();
    this.#overlayElement = undefined;
    this.#selectionElements?.forEach((el) => el.remove());
    this.#selectionElements?.clear();
    this.#selectionElements = undefined;
    this.#measureCtx = undefined;
    this.#contentResizeObserver?.disconnect();
    this.#contentResizeObserver = undefined;
    this.#lastContentWidth = -1;

    this.#shouldIgnoreSelectionChange = false;
    this.#selectionStart = undefined;
    this.#selections = undefined;
    this.#reservedSelections = undefined;
  }

  emitRender(
    fileContainer: HTMLElement,
    fileContents: FileContents,
    lineAnnotations: LineAnnotation<LAnnotation>[] | undefined,
    renderRange: RenderRange | undefined
  ): void {
    const shadowRoot =
      fileContainer.shadowRoot ?? fileContainer.attachShadow({ mode: 'open' });
    const contentEl =
      shadowRoot.querySelector<HTMLElement>('div[data-content]') ?? undefined;
    if (contentEl === undefined) {
      throw new Error('Could not edit the file.');
    }

    this.#wrap = this.#component?.options.overflow === 'wrap';
    this.#highlighter ??= areThemesAttached(
      this.#component?.options.theme ?? DEFAULT_THEMES
    )
      ? getHighlighterIfLoaded()
      : undefined;

    if (this.#fileContainer !== fileContainer) {
      this.#fileContainer = fileContainer;
      if (this.#styleElement !== undefined) {
        shadowRoot.appendChild(this.#styleElement);
      }
    }

    if (this.#contentElement !== contentEl) {
      this.#contentElement = extend(contentEl, {
        contentEditable: 'true',
        role: 'textbox',
        ariaMultiLine: 'true',
        autocapitalize: 'off',
        writingSuggestions: 'off',
        autocorrect: false,
        spellcheck: false,
        translate: false,
      });
      if (this.#overlayElement !== undefined) {
        contentEl.after(this.#overlayElement);
      }
      this.#contentElementDisposes?.forEach((dispose) => dispose());
      this.#contentElementDisposes = [
        addEventListener(
          contentEl,
          'keydown',
          (e) => {
            const command = resolveEditorCommandFromKeyboardEvent(e);
            if (command !== undefined) {
              e.preventDefault();
              this.#runCommand(command);
            }
          },
          { passive: false }
        ),

        addEventListener(
          contentEl,
          'copy',
          (e) => {
            e.preventDefault();
            e.clipboardData?.setData('text', this.#getSelectionText());
          },
          { passive: false }
        ),

        addEventListener(
          contentEl,
          'cut',
          (e) => {
            e.preventDefault();
            e.clipboardData?.setData('text', this.#getSelectionText());
            this.#replaceSelectionText('');
          },
          { passive: false }
        ),

        addEventListener(
          contentEl,
          'paste',
          (e) => {
            e.preventDefault();
            const text = e.clipboardData?.getData('text');
            if (text !== undefined) {
              // TODO(@ije): Add support of multiple selections paste
              // TODO(@ije): normalize the pasted text with textDocument.EOF
              this.#replaceSelectionText(text);
            }
          },
          { passive: false }
        ),

        addEventListener(
          contentEl,
          'beforeinput',
          (e) => {
            e.preventDefault();
            this.#handleInput(e.inputType, e.data);
          },
          { passive: false }
        ),

        addEventListener(
          contentEl,
          'compositionstart',
          () => {
            this.#shouldIgnoreSelectionChange = true;
          },
          { passive: true }
        ),

        addEventListener(
          contentEl,
          'compositionend',
          (e) => {
            this.#shouldIgnoreSelectionChange = false;
            this.#handleInput('insertText', e.data);
          },
          { passive: true }
        ),
      ];

      this.#contentResizeObserver?.disconnect();
      this.#contentResizeObserver = new ResizeObserver(() => {
        this.#handleLayoutResize();
      });
      this.#contentResizeObserver.observe(contentEl);
      this.#contentResizeObserver.observe(contentEl.parentElement!);
    }

    // measure the font width, line height, and tab size
    // purge the lineY cache if the line height or line annotations change
    const style = getComputedStyle(contentEl);
    const { fontSize, fontFamily, tabSize, lineHeight } = style;
    let lineHeighPx = 20;
    if (lineHeight.endsWith('px')) {
      lineHeighPx = Number(lineHeight.slice(0, -2));
    } else if (fontSize.endsWith('px')) {
      lineHeighPx = round(
        Number(fontSize.slice(0, -2)) * Number(lineHeight.slice(0, -2))
      );
    }
    this.#lastCharX = undefined;
    this.#lineHeight = lineHeighPx;
    this.#tabSize = Number(tabSize);
    this.#wrap = this.#component?.options.overflow === 'wrap';
    this.#lastContentWidth = this.#getContentWidth();
    this.#measureCtx ??=
      document.createElement('canvas').getContext('2d') ?? undefined;
    const font = fontSize + ' ' + fontFamily;
    if (
      this.#measureCtx !== undefined &&
      (this.#measureCtx.font !== font || this.#charWidth === -1)
    ) {
      this.#measureCtx.font = font;
      this.#charWidth = round(this.#measureCtx.measureText('0').width);
    }

    if (
      this.#textDocument === undefined ||
      this.#fileContents === undefined ||
      this.#fileContents.name !== fileContents.name ||
      this.#fileContents.lang !== fileContents.lang ||
      this.#fileContents.contents !== fileContents.contents
    ) {
      this.#fileContents = fileContents;
      this.#textDocument = new TextDocument(
        fileContents.name,
        fileContents.contents,
        fileContents.lang ?? getFiletypeFromFileName(fileContents.name)
      );
      this.#stateStackCache = undefined;
      this.#shouldIgnoreSelectionChange = false;
      this.#selectionElements?.forEach((el) => el.remove());
      this.#selectionElements?.clear();
      this.#component?.setSelectedLines(null);
      this.#selectionElements = undefined;
      this.#selections = undefined;
      this.#reservedSelections = undefined;
    }

    this.#lineYCache.clear();
    this.#wrapLineOffsetsCache.clear();
    this.#lastCharX = undefined;

    this.#lineAnnotations = lineAnnotations;
    this.#renderRange = renderRange;
    this.#prebuildStateStackCache();

    if (this.#selections !== undefined && this.#selections.length > 0) {
      // when re-rendering triggered by viewport scroll,
      // re-render the existing selections
      this.#updateSelections(this.#selections);
    }

    if (renderRange !== undefined) {
      console.log(
        '[diffs] render file:',
        fileContents.name,
        'RenderRange:',
        renderRange.startingLine +
          '-' +
          Math.min(
            renderRange.startingLine + renderRange.totalLines,
            this.#textDocument.lineCount
          ),
        'of',
        this.#textDocument.lineCount,
        'lines'
      );
    }

    if (this.#ensureScrollToLine !== undefined) {
      console.log('[diffs] ensureScrollToLine:', this.#ensureScrollToLine);
      this.#scrollToLine(this.#ensureScrollToLine);
    }
  }

  #initialize(): void {
    this.#styleElement = createElement('style', {
      dataset: 'editorCss',
      textContent: EDITOR_CSS,
    });

    this.#overlayElement = createElement('div', {
      dataset: 'editorOverlay',
    });

    this.#disposes = [
      addEventListener(
        document,
        'selectionchange',
        () => {
          if (this.#shouldIgnoreSelectionChange) {
            return;
          }

          const shadowRoot = this.#contentElement?.getRootNode();
          if (shadowRoot === undefined || !(shadowRoot instanceof ShadowRoot)) {
            return;
          }

          const selectionRaw = document.getSelection();
          const composedRange = selectionRaw?.getComposedRanges({
            shadowRoots: [shadowRoot],
          })?.[0];
          if (
            composedRange === undefined ||
            !this.#rangeBelongsToEditor(composedRange)
          ) {
            return;
          }

          let selection = convertSelection(composedRange, DirectionNone);
          if (selection === undefined) {
            return;
          }

          if (
            this.#isMouseDown &&
            this.#shiftKeyPressed &&
            this.#selections !== undefined &&
            this.#selections.length > 0
          ) {
            const primarySelection = this.#selections.at(-1)!;
            // before shift + click, the window selection has been cleared,
            // so we need to set the window selection manually with the new
            // selection
            this.#updateSelections(
              [extendSelection(primarySelection, selection)],
              true
            );
            return;
          }

          if (this.#isMouseDown) {
            if (this.#selectionStart !== undefined) {
              selection = createSelectionFrom(this.#selectionStart, selection);
            } else {
              this.#selectionStart = selection;
            }
          } else if (this.#selectionStart !== undefined) {
            selection.direction = createSelectionFrom(
              this.#selectionStart,
              selection
            ).direction;
          }

          if (this.#reservedSelections !== undefined) {
            this.#updateSelections([
              ...this.#reservedSelections.filter(
                (reservedSelection) =>
                  !selectionIntersects(reservedSelection, selection)
              ),
              selection,
            ]);
          } else {
            if (
              this.#isMouseDown ||
              this.#selections === undefined ||
              this.#selections.length === 0 ||
              this.#textDocument === undefined
            ) {
              this.#updateSelections([selection]);
            } else {
              // The selection change is triggered by the keyboard
              // For example, moving the cursor by arrow keys.
              if (isCollapsedSelection(selection)) {
                this.#updateSelections(
                  mapCursorMove(
                    this.#textDocument,
                    this.#selections,
                    selection.start
                  )
                );
              } else {
                // shift key is pressed when moving the cursor by
                const newSelections = mapSelectionShift(
                  this.#textDocument,
                  this.#selections,
                  selection
                );
                const hasMergedSelections =
                  newSelections.length !== this.#selections.length;
                this.#updateSelections(newSelections, false);
                if (hasMergedSelections) {
                  this.#updateWindowSelection(newSelections.at(-1)!);
                }
              }
            }
          }
        },
        { passive: true }
      ),

      addEventListener(
        document,
        'mousedown',
        (e) => {
          const target = e.composedPath()[0];
          if (target === undefined || !(target instanceof HTMLElement)) {
            return;
          }
          const { tagName, dataset } = target;
          if (
            !(
              (tagName === 'DIV' && dataset.line !== undefined) ||
              (tagName === 'SPAN' && dataset.char !== undefined)
            )
          ) {
            return;
          }

          this.#isMouseDown = true;
          this.#selectionStart = undefined;
          if (e.button === 0 && isPrimaryModifier(e)) {
            this.#reservedSelections = this.#selections?.map((selection) => ({
              ...selection,
            }));
          }
          if (e.shiftKey) {
            window.getSelection()?.empty();
            this.#shiftKeyPressed = true;
          } else {
            this.#selections = undefined;
          }
        },
        { passive: true }
      ),

      addEventListener(
        document,
        'mouseup',
        () => {
          this.#isMouseDown = false;
          this.#shiftKeyPressed = false;
          this.#selectionStart = undefined;
          this.#reservedSelections = undefined;
        },
        { passive: true }
      ),

      addEventListener(
        document,
        'keydown',
        (e) => {
          if (e.key === 'Shift') {
            this.#selectionStart = this.#selections?.at(-1);
          }
        },
        { passive: true }
      ),

      addEventListener(
        document,
        'keyup',
        (e) => {
          if (e.key === 'Shift') {
            this.#selectionStart = undefined;
          }
        },
        { passive: true }
      ),

      addEventListener(
        window,
        'resize',
        () => {
          this.#handleLayoutResize();
        },
        { passive: true }
      ),
    ];
  }

  #runCommand(command: EditorCommand) {
    const textDocument = this.#textDocument;
    if (textDocument === undefined) {
      return;
    }

    switch (command) {
      case 'selectAll':
        this.#updateSelections([getDocumentFullSelection(textDocument)]);
        break;

      case 'findNextMatch': {
        const selections = this.#selections;
        const textDocument = this.#textDocument;
        if (selections === undefined || textDocument === undefined) {
          break;
        }
        const hasCollapsed = selections.some(isCollapsedSelection);
        if (hasCollapsed) {
          const expanded: EditorSelection[] = selections.map((sel) => {
            if (isCollapsedSelection(sel)) {
              return expandCollapsedSelectionToWord(textDocument, sel);
            }
            return sel;
          });
          this.#updateSelections(expanded, true);
        } else {
          const nextMatch = findNexMatch(textDocument, selections);
          if (nextMatch !== undefined) {
            this.#updateSelections(nextMatch, true);
            this.#scrollToPrimaryCaret();
          }
        }
        break;
      }

      case 'indent':
      case 'outdent':
        if (this.#selections !== undefined) {
          const edits: TextEdit[] = [];
          const nextSelections: EditorSelection[] = [];
          for (const selection of this.#selections) {
            const startLine = selection.start.line;
            const outdent = command === 'outdent';
            if (startLine !== selection.end.line || outdent) {
              const ret = resolveIndentEdits(
                textDocument,
                selection,
                this.#tabSize,
                outdent
              );
              edits.push(...ret[0]);
              nextSelections.push(ret[1]);
            } else {
              const lineChar0 = textDocument.charAt({
                line: startLine,
                character: 0,
              });
              this.#replaceSelectionText(
                lineChar0 === '\t' ? '\t' : ' '.repeat(this.#tabSize)
              );
            }
          }
          if (edits.length > 0) {
            const change = textDocument.applyEdits(
              edits,
              true,
              this.#selections,
              nextSelections
            );
            if (change !== undefined) {
              this.#applyChange(change, nextSelections);
            }
          }
        }
        break;

      case 'moveCursorToDocStart':
      case 'moveCursorToDocEnd':
        {
          const atEnd = command === 'moveCursorToDocEnd';
          this.#updateSelections(
            [getDocumentBoundarySelection(textDocument, atEnd)],
            true
          );
          this.#scrollToLine(atEnd ? textDocument.lineCount - 1 : 0);
        }
        break;

      case 'undo':
        if (this.#textDocument?.canUndo === true) {
          const undoResult = this.#textDocument.undo();
          if (undoResult !== undefined) {
            this.#applyChange(...undoResult);
          }
        }
        break;

      case 'redo':
        if (this.#textDocument?.canRedo === true) {
          const redoResult = this.#textDocument.redo();
          if (redoResult !== undefined) {
            this.#applyChange(...redoResult);
          }
        }
        break;
    }
  }

  #handleLayoutResize() {
    const contentWidth = this.#getContentWidth();
    const widthChanged = contentWidth !== this.#lastContentWidth;
    this.#lastContentWidth = contentWidth;
    if (this.#wrap && widthChanged) {
      this.#lineYCache.clear();
      this.#lastCharX = undefined;
      this.#wrapLineOffsetsCache.clear();
      if (this.#selections !== undefined) {
        this.#updateSelections(this.#selections);
      }
    }
  }

  #rerender(
    change: TextDocumentChange,
    nextLineAnnotations?: LineAnnotation<LAnnotation>[] | undefined
  ) {
    // cancel existing background tokenzier task
    this.#backgroundTokenizer?.stop();

    const highlighter = this.#highlighter;
    const file = this.#component;
    const fileContents = this.#fileContents;
    const textDocument = this.#textDocument;
    const contentEl = this.#contentElement;
    const gutterEl = this.#contentElement?.previousElementSibling ?? undefined;
    if (
      highlighter === undefined ||
      file === undefined ||
      fileContents === undefined ||
      textDocument === undefined ||
      contentEl === undefined ||
      gutterEl === undefined ||
      !(gutterEl instanceof HTMLElement) ||
      gutterEl.dataset.gutter === undefined
    ) {
      return;
    }

    const t = performance.now();
    const grammar = highlighter.getLanguage(textDocument.languageId);
    const themeType = this.#getThemeType();
    const colorMap = this.#getThemeColorMap(themeType);
    const stateStackCache = this.#buildStateStackCache(
      textDocument,
      grammar,
      change.startLine
    );

    const { lineCount } = textDocument;
    const { startingLine = 0, totalLines = Infinity } = this.#renderRange ?? {};
    const renderRangeEndLine =
      totalLines === Infinity
        ? lineCount
        : Math.min(startingLine + totalLines, lineCount);

    let line = change.startLine;
    let state = stateStackCache[line];
    let settled = false;
    let dirtyLines: Map<number, Array<HighlightedToken>> = new Map();
    for (; line < renderRangeEndLine; line++) {
      const lineText = textDocument.getLineText(line);

      stateStackCache[line] = state;

      if (lineText.length > TOKENIZE_MAX_LINE_LENGTH) {
        console.warn(
          `[diffs] Line(${line}) too long to tokenize: ${lineText.length}`
        );
        dirtyLines.set(line, [[0, '', lineText]]);
      } else if (lineText === '' || lineText.trim() === '') {
        dirtyLines.set(line, [[0, '', lineText === '' ? ' ' : lineText]]);
      } else {
        const result = tokenizeLine(
          grammar,
          colorMap,
          lineText,
          state,
          TOKENIZE_TIME_LIMIT
        );
        dirtyLines.set(line, result.resolvedTokens);
        state = result.ruleStack;
      }

      settled =
        line >= change.endLine &&
        change.lineDelta === 0 &&
        stateStackCache[line + 1] !== undefined &&
        state.equals(stateStackCache[line + 1]);
      if (settled) {
        break;
      }
    }
    if (line < renderRangeEndLine) {
      stateStackCache[line + 1] = state;
    } else {
      stateStackCache[line] = state;
    }

    // Invalidate layout caches touched by the edit.
    // - line inserts/deletes shift line numbers, so clear from startLine onward
    // - wrapped edits can change visual height, which shifts downstream line Y
    if (change.lineDelta !== 0) {
      for (const line of this.#lineYCache.keys()) {
        if (line >= change.startLine) {
          this.#lineYCache.delete(line);
        }
      }
    }
    if (this.#wrap) {
      for (const line of this.#wrapLineOffsetsCache.keys()) {
        if (line >= change.startLine) {
          this.#wrapLineOffsetsCache.delete(line);
        }
      }
    }

    if (dirtyLines.size > 0) {
      const children = contentEl.children;
      const dirtyLineIndexes = new Set<number>(dirtyLines.keys());

      // update line elements that have been changed in the document
      for (let i = change.startLine - startingLine; i < children.length; i++) {
        if (dirtyLineIndexes.size === 0) {
          break;
        }
        const child = children[i] as HTMLElement | undefined;
        if (child?.dataset.lineIndex !== undefined) {
          const lineIndex = Number(child.dataset.lineIndex);
          if (dirtyLines.has(lineIndex)) {
            const tokens = dirtyLines.get(lineIndex)!;
            child.replaceChildren(
              ...tokens.map(([char, fg, textContent]) => {
                if (char === 0 && fg === '') {
                  if (textContent === '') {
                    return createElement('br');
                  }
                  return textContent;
                }
                return createElement('span', {
                  dataset: {
                    char: char.toString(),
                  },
                  style: `--diffs-token-${themeType}:${fg};`,
                  textContent: textContent,
                });
              })
            );
            dirtyLineIndexes.delete(lineIndex);
          }
        }
      }

      // create new line elements for new lines
      if (dirtyLineIndexes.size > 0) {
        for (const lineIndex of dirtyLineIndexes) {
          const tokens = dirtyLines.get(lineIndex)!;
          const lineNumber = String(lineIndex + 1);
          createElement(
            'div',
            {
              dataset: {
                line: lineNumber,
                lineType: 'context',
                lineIndex: lineIndex.toString(),
              },
              // oxlint-disable-next-line react/no-children-prop
              children: tokens.map(([char, fg, textContent]) => {
                if (char === 0 && fg === '') {
                  if (textContent === '') {
                    return createElement('br');
                  }
                  return textContent;
                }
                return createElement('span', {
                  dataset: {
                    char: char.toString(),
                  },
                  style: `--diffs-token-${themeType}:${fg};`,
                  textContent,
                });
              }),
            },
            contentEl
          );
          createElement(
            'div',
            {
              dataset: {
                lineType: 'context',
                columnNumber: lineNumber,
                lineIndex: lineIndex.toString(),
              },
              // oxlint-disable-next-line react/no-children-prop
              children: [
                createElement('span', {
                  dataset: {
                    lineNumberContent: '',
                  },
                  textContent: lineNumber,
                }),
              ],
            },
            gutterEl
          );
        }
      }
    }

    // remove line elements that have been deleted in the document
    if (change.lineDelta < 0) {
      for (const parent of [contentEl, gutterEl]) {
        const children = parent.children;
        for (let i = children.length - 1; i >= 0; i--) {
          const child = children[i] as HTMLElement;
          const { lineIndex, lineAnnotation } = child.dataset;
          if (lineIndex !== undefined || lineAnnotation !== undefined) {
            const lineIndexNum = Number(
              lineAnnotation !== undefined
                ? lineAnnotation.split(',')[1]
                : lineIndex
            );
            if (lineIndexNum < change.lineCount) {
              break;
            }
            child.remove();
          }
        }
      }
    }

    file.emitDirtyLines(themeType, dirtyLines);
    if (change.lineDelta !== 0) {
      gutterEl.style.gridRow = 'span ' + gutterEl.children.length;
      contentEl.style.gridRow = 'span ' + gutterEl.children.length;
      file.emitLineCountChange(change.lineCount, nextLineAnnotations);
    }

    if (!settled && line < lineCount) {
      requestAnimationFrame(() => {
        this.#backgroundTokenizer = new BackgroundTokenizer({
          grammar,
          colorMap,
          textDocument,
          onTokenize: (lines) => {
            file.emitDirtyLines(themeType, lines);
          },
        });
        this.#backgroundTokenizer.scheduleTokenize(line, state);
      });
      // TODO(@ije): should add another background tokenzier for the other theme?
    }

    console.log(
      `[diffs] re-render time: ${Math.round((performance.now() - t) * 1000) / 1000}ms`,
      'lastChange:',
      change,
      'dirtyLines:',
      dirtyLines.size,
      settled ? '(settled)' : ''
    );
  }

  #getThemeType(): 'dark' | 'light' {
    const { themeType } = this.#component?.options ?? {};
    if (themeType !== undefined && themeType !== 'system') {
      return themeType;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  #getThemeColorMap(themeType: 'dark' | 'light'): string[] {
    if (this.#highlighter === undefined || this.#component === undefined) {
      throw new Error('editor not initialized');
    }
    let themeName: string;
    const { theme = DEFAULT_THEMES } = this.#component.options;
    if (typeof theme === 'string') {
      themeName = theme;
    } else {
      themeName = theme[themeType];
    }
    if (this.#currentTheme !== themeName || this.#colorMap === undefined) {
      const ret = this.#highlighter.setTheme(themeName);
      this.#colorMap = ret.colorMap;
      this.#currentTheme = themeName;
    }
    return this.#colorMap;
  }

  #buildStateStackCache(
    textDocument: TextDocument<LAnnotation>,
    grammar: IGrammar,
    endLine: number
  ): StateStack[] {
    const stateStackCache = (this.#stateStackCache ??= [INITIAL]);
    const boundedEndLine = Math.min(
      Math.max(0, endLine),
      textDocument.lineCount
    );
    let line = Math.min(stateStackCache.length - 1, boundedEndLine);
    let state = stateStackCache[line] ?? INITIAL;
    for (; line < boundedEndLine; line++) {
      stateStackCache[line] = state;
      const lineText = textDocument.getLineText(line);
      if (
        lineText.length <= TOKENIZE_MAX_LINE_LENGTH &&
        lineText !== '' &&
        lineText.trim() !== ''
      ) {
        state = grammar.tokenizeLine2(
          lineText,
          state,
          TOKENIZE_TIME_LIMIT
        ).ruleStack;
      }
    }
    stateStackCache[line] = state;
    return stateStackCache;
  }

  #handleInput(inputType: string, data: string | null) {
    switch (inputType) {
      case 'insertText':
        this.#replaceSelectionText(data ?? '');
        break;
      case 'deleteContentBackward':
        this.#deleteSelectionText();
        break;
      case 'deleteContentForward':
        this.#deleteSelectionText(true);
        break;
      case 'insertParagraph':
        // TODO(@ije): use document.EOF instead of '\n'
        this.#replaceSelectionText('\n');
        break;
      default:
        console.warn(`[diffs] Unknown input type: ${inputType}`);
        break;
    }
  }

  #updateSelections(
    selections: EditorSelection[],
    updateWindowSelection = false
  ) {
    const primarySelection = selections.at(-1);
    if (primarySelection === undefined) {
      return;
    }
    this.#selections = selections;
    this.#primaryCaretElement = undefined;
    this.#component?.setSelectedLines(null);
    if (isCollapsedSelection(primarySelection)) {
      const line = primarySelection.end.line + 1;
      this.#component?.setSelectedLines({
        start: line,
        end: line,
      });
    }
    const fragment = document.createDocumentFragment();
    const renderCtx = {
      fragment,
      elements: new Map<string, HTMLElement>(),
    };
    selections.forEach((selection) => {
      if (selections.length > 1 || !isCollapsedSelection(selection)) {
        this.#renderSelection(renderCtx, selection);
      }
      this.#renderCaret(renderCtx, selection, selection === primarySelection);
    });
    this.#overlayElement?.appendChild(fragment);
    this.#selectionElements?.forEach((el) => el.remove());
    this.#selectionElements?.clear();
    this.#selectionElements = renderCtx.elements;
    if (updateWindowSelection) {
      this.#updateWindowSelection(primarySelection);
    }
  }

  #updateWindowSelection(primarySelection: EditorSelection) {
    const winSelection = window.getSelection();
    if (winSelection === null) {
      return;
    }
    let { start, end, direction } = primarySelection;
    if (comparePosition(start, end) > 0) {
      [start, end] = [end, start];
    }
    const startLineElement = this.#getLineElement(start.line);
    const endLineElement = this.#getLineElement(end.line);
    if (startLineElement === undefined || endLineElement === undefined) {
      return;
    }
    let [anchorNode, anchorOffset] = getSelectionAnchor(
      startLineElement,
      start.character
    );
    let [focusNode, focusOffset] = getSelectionAnchor(
      endLineElement,
      end.character
    );
    if (direction === DirectionBackward) {
      [anchorNode, anchorOffset, focusNode, focusOffset] = [
        focusNode,
        focusOffset,
        anchorNode,
        anchorOffset,
      ];
    }
    this.#shouldIgnoreSelectionChange = true;
    winSelection.setBaseAndExtent(
      anchorNode,
      anchorOffset,
      focusNode,
      focusOffset
    );
    setTimeout(() => {
      this.#shouldIgnoreSelectionChange = false;
    }, 0);
  }

  #scrollToPrimaryCaret() {
    if (this.#primaryCaretElement !== undefined) {
      this.#primaryCaretElement.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
    } else if (this.#selections !== undefined && this.#selections.length > 0) {
      const primarySelection = this.#selections.at(-1)!;
      const { start, end, direction } = primarySelection;
      const isBackward = direction === DirectionBackward;
      this.#scrollToLine(isBackward ? start.line : end.line);
    }
  }

  #scrollToLine(line: number) {
    const lineElement = this.#getLineElement(line);
    if (lineElement !== undefined) {
      const scrollToLine = () => {
        lineElement.scrollIntoView({ block: 'center', inline: 'start' });
      };
      if (this.#ensureScrollToLine !== undefined) {
        this.#ensureScrollToLine = undefined;
        requestAnimationFrame(scrollToLine);
      } else {
        scrollToLine();
      }
    }
    // if the line is not rendered yet(virtualized),
    // scroll to the approximate line position to trigger
    // the line to be rendered, then recall this function
    // to ensure the line is scrolled into view
    else {
      const lineAnnotations = (this.#lineAnnotations ?? []).filter(
        (annotation) => annotation.lineNumber < line
      ).length;
      const approximateLineY = (lineAnnotations + line) * this.#lineHeight;
      const anchor = createElement('span', {
        style: {
          position: 'absolute',
          top: approximateLineY + 'px',
          left: '0',
          width: '1px',
          height: '1px',
          pointerEvents: 'none',
        },
      });
      this.#contentElement?.getRootNode()?.appendChild(anchor);
      this.#ensureScrollToLine = line;
      anchor.scrollIntoView({ block: 'center', inline: 'start' });
      requestAnimationFrame(() => anchor.remove());
    }
  }

  #renderSelection(
    renderCtx: {
      fragment: DocumentFragment;
      elements: Map<string, HTMLElement>;
    },
    selection: EditorSelection
  ) {
    if (this.#textDocument === undefined) {
      return;
    }

    const { start, end } = selection;
    for (let ln = start.line; ln <= end.line; ln++) {
      if (!this.#isLineVisible(ln)) {
        continue;
      }

      const lineText = this.#textDocument.getLineText(ln);
      const startChar = ln === start.line ? start.character : 0;
      const endChar = ln === end.line ? end.character : lineText.length;

      if (this.#wrap) {
        const paddingInline = this.#charWidth; // 1ch, align to diff css: padding-inline: 1ch
        const contentWidth = this.#getContentWidth();
        const textWidth = 2 * paddingInline + this.#measureTextWidth(lineText);
        if (textWidth > contentWidth) {
          this.#renderWrappedSelection(
            renderCtx,
            selection,
            ln,
            lineText,
            startChar,
            endChar,
            paddingInline
          );
          continue;
        }
      }

      let left = 0;
      let width = 0;
      if (startChar === endChar && startChar === 0) {
        left = this.#getGutterWidth() + this.#charWidth; // gutter width + inline padding (1ch)
        width = ln === end.line ? 0 : this.#charWidth;
      } else {
        left = this.#getCharX(ln, startChar)[0];
        width =
          endChar === startChar ? 0 : this.#getCharX(ln, endChar)[0] - left;
      }
      this.#renderSelectionRange(
        renderCtx,
        selection,
        ln,
        0,
        startChar,
        endChar,
        width,
        left
      );
    }
  }

  // Render the selection on a wrapped logical line by splitting it into one
  // selection-range div per visual sub-line. For each wrap segment, we compute
  // the intersection with the line's selection range and render the slice in
  // segment-local coordinates so left/width line up with the visually wrapped
  // text. Zero-width slices that fall on intermediate segment boundaries are
  // skipped to avoid duplicate markers across consecutive visual lines.
  #renderWrappedSelection(
    renderCtx: {
      fragment: DocumentFragment;
      elements: Map<string, HTMLElement>;
    },
    selection: EditorSelection,
    line: number,
    lineText: string,
    startChar: number,
    endChar: number,
    paddingInline: number
  ) {
    const wrapOffsets = this.#wrapLineText(line);
    const segmentCount = wrapOffsets.length - 1;
    const lastSegmentIndex = segmentCount - 1;
    const offsetLeft = this.#getGutterWidth() + paddingInline;

    for (let w = 0; w < segmentCount; w++) {
      const segmentStart = wrapOffsets[w];
      const segmentEnd = wrapOffsets[w + 1];
      const wrapStartChar = Math.max(startChar, segmentStart);
      const wrapEndChar = Math.min(endChar, segmentEnd);

      // Selection range doesn't reach this visual segment.
      if (wrapStartChar > wrapEndChar) {
        continue;
      }

      // Zero-width slices on segment boundaries can appear on two consecutive
      // segments (end of one, start of the next). Only render at the natural
      // anchor positions: the very beginning of the first visual line, or the
      // very end of the last visual line.
      if (wrapStartChar === wrapEndChar) {
        const isAtLineStart = wrapStartChar === 0 && w === 0;
        const isAtLineEnd =
          wrapEndChar === lineText.length && w === lastSegmentIndex;
        if (!isAtLineStart && !isAtLineEnd) {
          continue;
        }
      }

      let segmentLeft: number;
      let segmentWidth: number;
      if (wrapStartChar === 0 && wrapEndChar === 0) {
        // Empty range pinned to line start (e.g. multi-line selection ending
        // with end.character === 0). Mirrors the non-wrap path.
        segmentLeft = offsetLeft;
        segmentWidth = line === selection.end.line ? 0 : paddingInline;
      } else {
        const prefixInSegment = lineText.slice(segmentStart, wrapStartChar);
        const prefixAsciiWidth =
          this.#getExpandedAsciiTextWidth(prefixInSegment);
        segmentLeft =
          offsetLeft +
          (prefixAsciiWidth !== -1
            ? prefixAsciiWidth
            : this.#measureTextWidth(prefixInSegment));

        if (wrapStartChar === wrapEndChar) {
          segmentWidth = 0;
        } else {
          const selectionInSegment = lineText.slice(wrapStartChar, wrapEndChar);
          const selectionAsciiWidth =
            this.#getExpandedAsciiTextWidth(selectionInSegment);
          segmentWidth =
            selectionAsciiWidth !== -1
              ? selectionAsciiWidth
              : this.#measureTextWidth(selectionInSegment);
        }
      }

      this.#renderSelectionRange(
        renderCtx,
        selection,
        line,
        w,
        wrapStartChar,
        wrapEndChar,
        segmentWidth,
        segmentLeft,
        w === lastSegmentIndex
      );
    }
  }

  // Render one selection range div for a single visual line. `applyEolSpacing`
  // controls whether the trailing one-character "line continuation" marker is
  // appended at the end. For wrapped logical lines this must be false on every
  // visual segment except the last one, since an intra-line wrap is not a real
  // newline and shouldn't visually extend past the wrapped content.
  #renderSelectionRange(
    renderCtx: {
      fragment: DocumentFragment;
      elements: Map<string, HTMLElement>;
    },
    selection: EditorSelection,
    ln: number,
    wrapLine: number,
    startChar: number,
    endChar: number,
    width: number,
    left: number,
    applyEolSpacing = true
  ) {
    const spacing =
      !applyEolSpacing ||
      selection.end.line === ln ||
      (startChar === endChar && ln !== selection.start.line)
        ? 0
        : this.#charWidth;
    const css = `width:${width + spacing}px;transform:translateY(${this.#getLineY(ln) + wrapLine * this.#lineHeight}px) translateX(${left}px);`;
    const cacheKey = 'selection-range-' + css;
    const selectionEls = this.#selectionElements;

    if (renderCtx.elements.has(cacheKey)) {
      return;
    }

    let rangeEl: HTMLElement | undefined;
    if (selectionEls?.has(cacheKey) === true) {
      rangeEl = selectionEls.get(cacheKey)!;
      selectionEls.delete(cacheKey);
    } else {
      rangeEl = createElement(
        'div',
        {
          dataset: 'selectionRange',
          style: { cssText: css },
        },
        renderCtx.fragment
      );
    }

    renderCtx.elements.set(cacheKey, rangeEl);
  }

  #renderCaret(
    renderCtx: {
      fragment: DocumentFragment;
      elements: Map<string, HTMLElement>;
    },
    selection: EditorSelection,
    isPrimary: boolean
  ) {
    const { start, end, direction } = selection;
    const isBackward = direction === DirectionBackward;
    const line = isBackward ? start.line : end.line;
    const character = isBackward ? start.character : end.character;
    if (!this.#isLineVisible(line)) {
      return;
    }
    const [left, wrapLine] = this.#getCharX(line, character);
    const cacheKey = 'caret-' + line + '(' + wrapLine + ')-' + character;
    if (renderCtx.elements.has(cacheKey)) {
      return;
    }
    const caretEl = createElement(
      'div',
      {
        dataset: 'caret',
        style: {
          transform: `translateY(${this.#getLineY(line) + wrapLine * this.#lineHeight}px) translateX(${left - 1}px)`,
        },
      },
      renderCtx.fragment
    );
    renderCtx.elements.set(cacheKey, caretEl);
    if (isPrimary) {
      this.#primaryCaretElement = caretEl;
    }
  }

  #getSelectionText() {
    const textDocument = this.#textDocument;
    const selections = this.#selections;
    if (textDocument === undefined || selections === undefined) {
      return '';
    }
    return getSelectionText(textDocument, selections);
  }

  // replace the selection text
  #replaceSelectionText(text: string | string[]) {
    const selections = this.#selections;
    if (selections === undefined) {
      return;
    }
    const textDocument = this.#textDocument;
    const primarySelection = selections.at(-1);
    if (textDocument == null || primarySelection == null) {
      return;
    }
    const lineAnnotations = this.#lineAnnotations;
    const { nextSelections, change } =
      Array.isArray(text) && text.length === selections.length
        ? applyTextReplaceToSelections<LAnnotation>(
            textDocument,
            selections,
            text,
            lineAnnotations
          )
        : applyTextChangeToSelections<LAnnotation>(
            textDocument,
            selections,
            {
              start: textDocument.offsetAt(primarySelection.start),
              end: textDocument.offsetAt(primarySelection.end),
              text: Array.isArray(text) ? text.join('\n') : text,
            },
            lineAnnotations
          );

    if (change !== undefined) {
      this.#applyChange(
        change,
        nextSelections,
        this.#applyChangeToLineAnnotations(change)
      );
    }
  }

  #deleteSelectionText(forward: boolean = false) {
    const selections = this.#selections;
    const textDocument = this.#textDocument;
    if (selections === undefined || textDocument === undefined) {
      return;
    }

    const primarySelection = selections.at(-1);
    if (primarySelection === undefined) {
      return;
    }

    const edit = isCollapsedSelection(primarySelection)
      ? (() => {
          const offset = textDocument.offsetAt(primarySelection.start);
          const nextOffset = forward
            ? Math.min(textDocument.getText().length, offset + 1)
            : Math.max(0, offset - 1);
          return {
            start: Math.min(offset, nextOffset),
            end: Math.max(offset, nextOffset),
            text: '',
          };
        })()
      : {
          start: textDocument.offsetAt(primarySelection.start),
          end: textDocument.offsetAt(primarySelection.end),
          text: '',
        };

    const { nextSelections, change } = applyTextChangeToSelections<LAnnotation>(
      textDocument,
      selections,
      edit,
      this.#lineAnnotations,
      this.#tabSize
    );

    if (change !== undefined) {
      this.#applyChange(
        change,
        nextSelections,
        this.#applyChangeToLineAnnotations(change)
      );
    }
  }

  #applyChange(
    change: TextDocumentChange,
    selections?: EditorSelection[],
    lineAnnotations?: LineAnnotation<LAnnotation>[]
  ) {
    const fileContents = this.#fileContents;
    const textDocument = this.#textDocument;
    const onChange = this.#onChange;
    if (
      fileContents !== undefined &&
      textDocument !== undefined &&
      onChange !== undefined
    ) {
      const { contents: _, ...file } = fileContents;
      Object.defineProperty(file, 'contents', {
        get() {
          return textDocument.getText();
        },
      });
      this.#emitChange(
        file as FileContents,
        lineAnnotations ?? this.#lineAnnotations
      );
    }
    this.#selections = selections;
    this.#rerender(change, lineAnnotations);
    if (this.#selections !== undefined) {
      // since we prevent the default input event,
      // we need to update the window selection manually
      // and scroll to the primary caret
      this.#updateSelections(this.#selections, true);
      this.#scrollToPrimaryCaret();
    }
  }

  #applyChangeToLineAnnotations(
    change: TextDocumentChange
  ): LineAnnotation<LAnnotation>[] | undefined {
    if (this.#lineAnnotations !== undefined) {
      const nextLineAnnotations =
        applyDocumentChangeToLineAnnotations<LAnnotation>(
          change,
          this.#lineAnnotations
        );
      if (nextLineAnnotations !== this.#lineAnnotations) {
        this.#textDocument?.setLastUndoLineAnnotationsAfter(
          nextLineAnnotations
        );
        return nextLineAnnotations;
      }
    }
    return undefined;
  }

  #getLineElement(line: number): HTMLElement | undefined {
    const contentElement = this.#contentElement;
    if (contentElement === undefined) {
      return undefined;
    }
    const { children } = contentElement;
    if (children === undefined) {
      return undefined;
    }
    // check if the line is within the render range
    if (this.#renderRange !== undefined) {
      const { startingLine = 0, totalLines } = this.#renderRange;
      if (
        line < 0 ||
        (totalLines !== Infinity && line >= startingLine + totalLines)
      ) {
        return undefined;
      }
      for (let i = line - startingLine; i <= children.length; i++) {
        const child = children[i] as HTMLElement | undefined;
        if (
          child !== undefined &&
          child.dataset.line !== undefined &&
          child.dataset.lineIndex !== undefined &&
          Number(child.dataset.lineIndex) === line
        ) {
          return child;
        }
      }
    }
    // fallback to query selector
    return (
      contentElement.querySelector<HTMLElement>(
        `[data-line][data-line-index="${line}"]`
      ) ?? undefined
    );
  }

  #getGutterWidth() {
    const diffsColumnNumbertWidth =
      this.#contentElement?.parentElement?.style.getPropertyValue(
        '--diffs-column-number-width'
      ) ?? '';
    if (
      diffsColumnNumbertWidth.length > 2 &&
      diffsColumnNumbertWidth.endsWith('px')
    ) {
      return Number(diffsColumnNumbertWidth.slice(0, -2));
    }
    const gutterElement =
      this.#contentElement?.previousElementSibling ?? undefined;
    if (
      gutterElement === undefined ||
      !gutterElement.hasAttribute('data-gutter')
    ) {
      return 0;
    }
    return (gutterElement as HTMLElement).offsetWidth ?? 0;
  }

  #getContentWidth() {
    const diffsColumnContentWidth =
      this.#contentElement?.parentElement?.style.getPropertyValue(
        '--diffs-column-content-width'
      ) ?? '';
    if (
      diffsColumnContentWidth.length > 2 &&
      diffsColumnContentWidth.endsWith('px')
    ) {
      return Number(diffsColumnContentWidth.slice(0, -2));
    }
    return this.#contentElement?.offsetWidth ?? 0;
  }

  // get line top(y-coordinate) position
  #getLineY(line: number) {
    const cachedY = this.#lineYCache.get(line);
    if (cachedY !== undefined) {
      return cachedY;
    }

    const lineElement = this.#getLineElement(line);
    if (lineElement === undefined) {
      return -1;
    }

    // cold(slow) path: measure line top position from DOM (will cause reflow)
    const y = lineElement.offsetTop;
    this.#lineYCache.set(line, y);
    return y;
  }

  // Return the visual position for a character. Wrapped lines include the
  // visual line index so carets can be placed on the correct row.
  #getCharX(line: number, char: number): [x: number, wrapLine: number] {
    if (
      this.#lastCharX !== undefined &&
      this.#lastCharX[0] === line &&
      this.#lastCharX[1] === char
    ) {
      return [this.#lastCharX[2], this.#lastCharX[3]];
    }

    const lineText = this.#textDocument?.getLineText(line);
    const offsetLeft = this.#getGutterWidth() + this.#charWidth; // gutter width + inline padding (1ch)
    if (lineText === undefined || lineText.length === 0 || char <= 0) {
      return [offsetLeft, 0];
    }

    const boundedCharacter = Math.min(char, lineText.length);
    const textBeforeCharacter = lineText.slice(0, boundedCharacter);
    const asciiWidth = this.#getExpandedAsciiTextWidth(textBeforeCharacter);

    let left = 0;
    let wrapLine = 0;
    if (asciiWidth !== -1) {
      left = offsetLeft + asciiWidth;
    } else {
      left = offsetLeft + this.#measureTextWidth(textBeforeCharacter);
    }

    if (this.#wrap) {
      const contentWidth = this.#getContentWidth();
      const width = 2 * offsetLeft + this.#measureTextWidth(lineText);
      if (width > contentWidth) {
        const wrapOffsets = this.#wrapLineText(line);
        for (let w = 0; w + 1 < wrapOffsets.length; w++) {
          const segmentStart = wrapOffsets[w];
          const segmentEnd = wrapOffsets[w + 1];
          if (boundedCharacter <= segmentEnd) {
            wrapLine = w;
            const prefixInSegment = lineText.slice(
              segmentStart,
              boundedCharacter
            );
            const segmentAsciiWidth =
              this.#getExpandedAsciiTextWidth(prefixInSegment);
            if (segmentAsciiWidth !== -1) {
              left = offsetLeft + segmentAsciiWidth;
            } else {
              left = offsetLeft + this.#measureTextWidth(prefixInSegment);
            }
            break;
          }
        }
      }
    }

    if (this.#lastCharX !== undefined) {
      this.#lastCharX[0] = line;
      this.#lastCharX[1] = char;
      this.#lastCharX[2] = left;
      this.#lastCharX[3] = wrapLine;
    } else {
      this.#lastCharX = [line, char, left, wrapLine];
    }

    return [left, wrapLine];
  }

  #getExpandedAsciiTextWidth(text: string) {
    let columns = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) > 127) {
        return -1;
      }
      columns += text.charCodeAt(i) === /* '\t' */ 9 ? this.#tabSize : 1;
    }
    return columns * this.#charWidth;
  }

  #measureTextWidth(text: string) {
    if (this.#measureCtx === undefined) {
      throw new Error('Measure context not initialized');
    }
    const textWithExpandedTabs = text.replaceAll(
      '\t',
      ' '.repeat(this.#tabSize)
    );
    return this.#measureCtx.measureText(textWithExpandedTabs).width;
  }

  // Compute how a logical line of text is broken into visual lines when line
  // wrapping is enabled.
  #wrapLineText(line: number): Uint32Array {
    const cachedOffsets = this.#wrapLineOffsetsCache.get(line);
    if (cachedOffsets !== undefined) {
      return cachedOffsets;
    }

    const lineText = this.#textDocument?.getLineText(line);
    if (lineText === undefined || lineText.length === 0) {
      const offsets = new Uint32Array([0]);
      this.#wrapLineOffsetsCache.set(line, offsets);
      return offsets;
    }

    const div = createElement(
      'div',
      {
        style: {
          position: 'absolute',
          top: '0',
          left: '0',
          width: '100%',
          visibility: 'hidden',
          pointerEvents: 'none',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          font: 'inherit',
          paddingInline: '1ch',
          tabSize: this.#tabSize.toString(),
        },
        textContent: lineText,
      },
      this.#contentElement
    );
    const textNode = div.firstChild as Text;
    const range = document.createRange();
    const starts: number[] = [];

    try {
      let lastTop = Number.NEGATIVE_INFINITY;

      for (let i = 0; i < lineText.length; i++) {
        range.setStart(textNode, i);
        range.setEnd(textNode, i + 1);

        // A new visual line starts whenever the character's top edge moves
        // below the previous character's top edge.
        const { top } = range.getBoundingClientRect();
        if (top > lastTop) {
          starts.push(i);
          lastTop = top;
        }
      }

      const offsets = new Uint32Array(starts.length + 1);
      for (let i = 0; i < starts.length; i++) {
        offsets[i] = starts[i]!;
      }
      offsets[starts.length] = lineText.length;
      this.#wrapLineOffsetsCache.set(line, offsets);
      return offsets;
    } finally {
      div.remove();
    }
  }

  // check if the web selection belongs to editor
  #rangeBelongsToEditor({ startContainer, endContainer }: StaticRange) {
    const contentEl = this.#contentElement;
    if (contentEl === undefined) {
      return false;
    }
    return (
      contentEl.contains(startContainer) && contentEl.contains(endContainer)
    );
  }

  // Check whether a line is visible in the currently rendered line window.
  #isLineVisible(line: number): boolean {
    const lineCount = this.#textDocument?.lineCount;
    if (line < 0 || (lineCount !== undefined && line >= lineCount)) {
      return false;
    }
    if (this.#renderRange === undefined) {
      return true;
    }
    const { startingLine, totalLines } = this.#renderRange;
    if (line < startingLine) {
      return false;
    }
    if (totalLines === Infinity) {
      return true;
    }
    return line < startingLine + totalLines;
  }
}

export function edit<LAnnotation>(
  file: File<LAnnotation>,
  onChange?: (
    file: FileContents,
    lineAnnotations?: LineAnnotation<LAnnotation>[]
  ) => void
): void {
  const editor = new Editor<LAnnotation>();
  editor.edit(file, onChange);
}
