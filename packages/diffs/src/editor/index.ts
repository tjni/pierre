import {
  EncodedTokenMetadata,
  type IGrammar,
  INITIAL,
  type StateStack,
} from 'shiki/textmate';

import {
  areThemesAttached,
  DEFAULT_THEMES,
  getFiletypeFromFileName,
  getHighlighterIfLoaded,
} from '..';
import type { File } from '../components/File';
import {
  type EditorCommand,
  isPrimaryModifier,
  resolveEditorCommandFromKeyboardEvent,
} from '../editor/editorCommand';
import {
  applyTextChangeToSelections,
  applyTextReplaceToSelections,
  mapSelectionMove,
  mapSelectionRangeMove,
} from '../editor/editorMultiSelections';
import type { EditorSelection } from '../editor/editorSelection';
import {
  comparePosition,
  convertSelection,
  isCollapsedSelection,
  resolveIndentEdits,
  SelectionDirection,
  selectionIntersects,
} from '../editor/editorSelection';
import {
  addEventListener,
  createElement,
  extend,
  isCodeLineTarget,
  resolveDirtyLines,
} from '../editor/editorUtils';
import {
  type ResolvedTextEdit,
  TextDocument,
  type TextEdit,
} from '../editor/textDocument';
import type { DiffsHighlighter, FileContents, RenderRange } from '../types';
import {
  EDITOR_CSS,
  TOKENIZE_MAX_LINE_LENGTH,
  TOKENIZE_TIME_LIMIT,
} from './constants';
import {
  createTextareaSnapshot,
  getSelectionDirectionFromTextarea,
  resolveTextareaChange,
  type TextareaSnapshot,
  toTextareaSelectionDirection,
} from './editorTextarea';

export class Editor<LAnnotation> {
  #disposes?: (() => void)[];
  #onChange?: (file: FileContents) => void;

  // css properties
  #measureCtx?: CanvasRenderingContext2D;
  #charWidth = -1;
  #lineHeight = 20;
  #tabSize = 2;

  // file
  #file?: File<LAnnotation>;
  #fileContents?: FileContents;
  #textDocument?: TextDocument;

  // highlighter
  #highlighter?: DiffsHighlighter;
  #colorMap?: Map<string, string[]>;
  #grammar?: IGrammar;
  #renderRange?: RenderRange;

  // cache
  #stateStackCache?: StateStack[];
  #lineYCache = new Map<number, number>();
  #lastCharX?: [line: number, character: number, x: number];

  // dom elements
  #contentEl?: HTMLElement;
  #styleEl?: HTMLStyleElement;
  #textareaEl?: HTMLTextAreaElement;
  #selectionEls?: Map<string, HTMLElement>;

  // state
  #selectionStartX = 0;
  #selectionStartY = 0;
  #selectionEndX = 0;
  #selectionEndY = 0;
  #shouldIgnoreSelectionChange = false;
  #textareaSnapshot?: TextareaSnapshot;
  #reservedSelections?: EditorSelection[];
  #selections?: EditorSelection[];

  edit(
    file: File<LAnnotation>,
    options?: {
      onChange?: (file: FileContents) => void;
    }
  ): () => void {
    file.__addEditorHook((fileContainer, fileContents, renderRange) => {
      this.#initialize(fileContainer, fileContents, renderRange);
    });
    this.#file = file;
    this.#highlighter ??= areThemesAttached(
      file.options.theme ?? DEFAULT_THEMES
    )
      ? getHighlighterIfLoaded()
      : undefined;
    this.#onChange = options?.onChange;
    return this.cleanUp.bind(this);
  }

  setSelections(selections: EditorSelection[], resetTextarea = true): void {
    const primarySelection = selections.at(-1);
    if (primarySelection === undefined) {
      return;
    }
    if (resetTextarea) {
      this.#textareaSnapshot = undefined;
    }
    const shouldUpdateTextarea =
      Math.max(0, primarySelection.start.line - 1) !==
      this.#textareaSnapshot?.startLine;
    this.#selections = selections;
    this.#renderSelections(selections, primarySelection);
    if (shouldUpdateTextarea) {
      this.#updateTextarea(primarySelection);
    } else if (
      this.#textareaEl !== undefined &&
      this.#textDocument !== undefined &&
      this.#textareaSnapshot !== undefined
    ) {
      const nextTextareaSnapshot = createTextareaSnapshot(
        this.#textDocument,
        primarySelection
      );
      const shouldSyncTextarea =
        nextTextareaSnapshot.text !== this.#textareaEl.value ||
        nextTextareaSnapshot.selectionStart !==
          this.#textareaEl.selectionStart ||
        nextTextareaSnapshot.selectionEnd !== this.#textareaEl.selectionEnd;
      if (shouldSyncTextarea) {
        this.#updateTextarea(primarySelection);
      } else {
        this.#textareaSnapshot = nextTextareaSnapshot;
      }
    }
  }

  cleanUp(): void {
    this.#disposes?.forEach((dispose) => dispose());
    this.#disposes = undefined;
    this.#onChange = undefined;

    this.#measureCtx = undefined;

    this.#file = undefined;
    this.#fileContents = undefined;
    this.#textDocument = undefined;

    this.#highlighter = undefined;
    this.#colorMap = undefined;
    this.#grammar = undefined;
    this.#renderRange = undefined;

    this.#stateStackCache = undefined;
    this.#lineYCache.clear();
    this.#lastCharX = undefined;

    this.#contentEl = undefined;
    this.#styleEl?.remove();
    this.#styleEl = undefined;
    this.#textareaEl?.remove();
    this.#textareaEl = undefined;
    this.#selectionEls?.forEach((el) => el.remove());
    this.#selectionEls?.clear();
    this.#selectionEls = undefined;

    this.#shouldIgnoreSelectionChange = false;
    this.#textareaSnapshot = undefined;
    this.#selections = undefined;
    this.#reservedSelections = undefined;
  }

  #initialize(
    fileContainer: HTMLElement,
    fileContents: FileContents,
    renderRange: RenderRange | undefined
  ): void {
    if (
      this.#textDocument === undefined ||
      this.#fileContents === undefined ||
      this.#fileContents.contents !== fileContents.contents ||
      this.#fileContents.lang !== fileContents.lang
    ) {
      this.#fileContents = fileContents;
      this.#textDocument = new TextDocument(
        fileContents.name,
        fileContents.contents,
        fileContents.lang ?? getFiletypeFromFileName(fileContents.name)
      );
      this.#grammar = undefined;
      this.#stateStackCache = undefined;
      this.#selections = undefined;
    }

    this.#renderRange = renderRange;
    setTimeout(() => {
      this.#prebuildStateStackCache();
    }, 500);

    const shadowRoot =
      fileContainer.shadowRoot ?? fileContainer.attachShadow({ mode: 'open' });

    this.#contentEl = shadowRoot.querySelector('[data-content]') ?? undefined;
    if (this.#contentEl === undefined) {
      throw new Error('could not edit the file.');
    }

    this.#textareaEl ??= extend(
      createElement('textarea', { dataset: 'textarea' }),
      {
        autocapitalize: 'off',
        autocomplete: 'off',
        autocorrect: false,
        spellcheck: false,
        wrap: 'off',
      }
    );
    this.#contentEl.appendChild(this.#textareaEl);

    this.#styleEl ??= createElement(
      'style',
      { dataset: 'editorCss', textContent: EDITOR_CSS },
      shadowRoot
    );

    this.#disposes ??= [
      addEventListener(document, 'selectionchange', () => {
        if (this.#shouldIgnoreSelectionChange) {
          return;
        }

        // if caret position changes in textarea, sync the textarea state.
        const textareaEl = this.#textareaEl;
        const textareaSnapshot = this.#textareaSnapshot;
        if (textareaEl !== undefined && textareaSnapshot !== undefined) {
          const { selectionStart, selectionEnd } = textareaEl;
          if (
            (textareaSnapshot.selectionStart !== selectionStart ||
              textareaSnapshot.selectionEnd !== selectionEnd) &&
            textareaSnapshot.text === textareaEl.value
          ) {
            textareaSnapshot.selectionStart = selectionStart;
            textareaSnapshot.selectionEnd = selectionEnd;
            this.#syncTextareaState();
            return;
          }
        }

        const selectionRaw = document.getSelection();
        const composedRanges = selectionRaw?.getComposedRanges({
          shadowRoots: [shadowRoot],
        });

        if (
          composedRanges === undefined ||
          !this.#selectionBelongsToEditor(composedRanges)
        ) {
          return;
        }

        const selection = convertSelection(
          composedRanges,
          this.#computeMouseSelectionDirection()
        );
        if (selection !== null) {
          this.#textareaSnapshot = undefined;
          if (this.#reservedSelections !== undefined) {
            this.setSelections([
              ...this.#reservedSelections.filter(
                (reservedSelection) =>
                  !selectionIntersects(reservedSelection, selection)
              ),
              selection,
            ]);
          } else {
            this.setSelections([selection]);
          }
        }
      }),

      addEventListener(document, 'mousedown', (e) => {
        if (!isCodeLineTarget(e.composedPath()[0])) {
          return;
        }

        if (e.button === 0 && isPrimaryModifier(e)) {
          this.#reservedSelections = this.#selections?.map((selection) => ({
            ...selection,
          }));
        } else {
          this.#reservedSelections = undefined;
        }

        if (!e.shiftKey) {
          this.#selectionStartY = e.clientY;
          this.#selectionStartX = e.clientX;
        }
        this.#selectionEndX = e.clientX;
        this.#selectionEndY = e.clientY;
      }),

      addEventListener(document, 'mouseup', (e) => {
        const target = e.composedPath()[0];
        if (!isCodeLineTarget(target)) {
          return;
        }

        this.#reservedSelections = undefined;
        this.#textareaEl?.focus();
      }),

      // Selection.getComposedRanges currently does not preserve the drag direction.
      // The workaround is to check the mousemove event to determine the direction of the drag operation.
      addEventListener(document, 'mousemove', (e) => {
        if ((e.buttons & 1) !== 1) {
          return;
        }
        this.#selectionEndX = e.clientX;
        this.#selectionEndY = e.clientY;
      }),

      addEventListener(this.#textareaEl, 'keydown', (e) => {
        const command = resolveEditorCommandFromKeyboardEvent(e);
        if (command !== undefined) {
          e.preventDefault();
          void this.#runCommand(command);
        }
      }),

      addEventListener(this.#textareaEl, 'input', () => {
        if (this.#shouldIgnoreSelectionChange) {
          return;
        }

        this.#syncTextareaState();
      }),
    ];

    this.#lineYCache.clear();
    this.#lastCharX = undefined;

    if (this.#selections !== undefined) {
      this.#selectionEls?.forEach((el) => el.remove());
      this.#selectionEls?.clear();
      this.setSelections(this.#selections);
      this.#textareaEl.focus();
    }

    this.#getCSSProperites();

    console.log('Editor initialized.', {
      renderRange,
      tabSize: this.#tabSize,
      lineHeight: this.#lineHeight,
      charWidth: this.#charWidth,
    });
  }

  #computeMouseSelectionDirection(): SelectionDirection {
    const startLine = Math.ceil(this.#selectionStartY / this.#lineHeight);
    const endLine = Math.ceil(this.#selectionEndY / this.#lineHeight);
    if (endLine !== startLine) {
      return endLine > startLine
        ? SelectionDirection.Forward
        : SelectionDirection.Backward;
    }
    if (this.#selectionEndX !== this.#selectionStartX) {
      return this.#selectionEndX > this.#selectionStartX
        ? SelectionDirection.Forward
        : SelectionDirection.Backward;
    }
    return SelectionDirection.None;
  }

  #rerender(textDocument: TextDocument, nextSelections?: EditorSelection[]) {
    const file = this.#file;
    const fileContents = this.#fileContents;
    const contentEl = this.#contentEl;
    if (
      file === undefined ||
      fileContents === undefined ||
      contentEl === undefined
    ) {
      return;
    }

    if (this.#highlighter !== undefined) {
      const t = performance.now();

      const lastChange = textDocument.lastChange;
      const { startingLine = 0, totalLines = Infinity } =
        this.#renderRange ?? {};
      const endLine =
        totalLines === Infinity
          ? textDocument.lineCount
          : Math.min(startingLine + totalLines, textDocument.lineCount);
      const previousLineCount =
        lastChange?.previousLineCount ?? textDocument.lineCount;
      const prevEndLine =
        totalLines === Infinity
          ? previousLineCount
          : Math.min(startingLine + totalLines, previousLineCount);
      const { dirtyLines, dirtyLineStart, dirtyLineEnd, tokenizerStartLine } =
        resolveDirtyLines(lastChange, startingLine, endLine);
      const linesChange = lastChange?.lineDelta ?? 0;

      for (let line = endLine; line < prevEndLine; line++) {
        this.#lineYCache.delete(line);
        this.#getLineElement(line)?.remove();
      }

      const grammar = (this.#grammar ??= this.#highlighter.getLanguage(
        textDocument.languageId
      ));
      const previousStateStackCache = this.#stateStackCache;
      if (dirtyLineStart !== -1) {
        this.#stateStackCache = previousStateStackCache?.slice(
          0,
          tokenizerStartLine + 1
        );
      }

      const updateLineEl = (line: number, children: Element[]) => {
        const lineEl = createElement('div', {
          dataset: {
            line: String(line + 1),
            lineIndex: String(line),
            lineType: 'context',
          },
        });
        lineEl.replaceChildren(...children);
        const prevLineEl = contentEl.querySelector(
          `[data-line-index="${line}"]`
        );
        if (prevLineEl !== null) {
          prevLineEl.replaceWith(lineEl);
        } else {
          contentEl.insertBefore(lineEl, this.#textareaEl ?? null);
        }
      };

      const colorMap = {
        dark: this.#getThemeColorMap('dark'),
        light: this.#getThemeColorMap('light'),
      };

      let state =
        dirtyLineStart === -1
          ? INITIAL
          : this.#buildStateStackCache(textDocument, grammar, dirtyLineStart);
      for (let line = dirtyLineStart; line >= 0 && line < endLine; line++) {
        const isDirty = dirtyLines.has(line);
        const previousState = previousStateStackCache?.[line];
        const didLineStateChange =
          previousState !== undefined && !state.equals(previousState);
        const shouldUpdateLineEl =
          isDirty ||
          didLineStateChange ||
          (line > dirtyLineEnd && previousState === undefined);
        const lineText = textDocument.getLineText(line);
        this.#stateStackCache ??= [INITIAL];
        this.#stateStackCache[line] = state;

        if (lineText.length > TOKENIZE_MAX_LINE_LENGTH) {
          if (shouldUpdateLineEl) {
            console.warn(
              `[diffs] Line(${line}) too long to tokenize: ${lineText.length}`
            );
            updateLineEl(line, [
              createElement('span', { textContent: lineText }),
            ]);
          }
          this.#stateStackCache[line + 1] = state;
          if (
            line >= dirtyLineEnd &&
            this.#isStateStackCacheSettled(previousStateStackCache, line, state)
          ) {
            break;
          }
          continue;
        }

        if (lineText === '' || lineText.trim() === '') {
          if (shouldUpdateLineEl) {
            updateLineEl(line, [
              createElement('span', {
                textContent: lineText === '' ? ' ' : lineText,
              }),
            ]);
          }
          this.#stateStackCache[line + 1] = state;
          if (
            line >= dirtyLineEnd &&
            this.#isStateStackCacheSettled(previousStateStackCache, line, state)
          ) {
            break;
          }
          continue;
        }

        // even the line is NOT dirty, we still need to tokenize it to get the new state
        const result = grammar.tokenizeLine2(
          lineText,
          state,
          TOKENIZE_TIME_LIMIT
        );
        if (result.stoppedEarly) {
          console.warn(
            `[diffs] Time limit reached when tokenizing line: ${lineText.substring(0, 100)}`
          );
        }
        if (shouldUpdateLineEl) {
          const rawTokens = result.tokens;
          const lineLength = lineText.length;
          const tokensLength = rawTokens.length / 2;
          const tokens: [char: number, style: string, text: string][] = [];
          const spans: Element[] = [];
          for (let j = 0; j < tokensLength; j++) {
            const offset = rawTokens[2 * j];
            const nextOffset =
              j + 1 < tokensLength ? rawTokens[2 * j + 2] : lineLength;
            if (offset === nextOffset) {
              // should never reach here, skip if happens anyway
              continue;
            }
            const metadata = rawTokens[2 * j + 1];
            const bg = EncodedTokenMetadata.getForeground(metadata);
            const darkFG = colorMap.dark[bg];
            const lightFG = colorMap.light[bg];
            const cssText = `--diffs-token-dark:${darkFG};--diffs-token-light:${lightFG}`;
            const tokenText = lineText.slice(offset, nextOffset);
            tokens.push([offset, cssText, tokenText]);
            spans.push(
              createElement('span', {
                dataset: { char: String(offset) },
                style: { cssText },
                textContent: tokenText,
              })
            );
          }
          updateLineEl(line, spans);
          this.#file?.updateRenderCacheAt(line, tokens);
        }
        state = result.ruleStack;
        this.#stateStackCache[line + 1] = state;
        if (
          line >= dirtyLineEnd &&
          this.#isStateStackCacheSettled(previousStateStackCache, line, state)
        ) {
          break;
        }
      }

      console.log(
        `[diffs] re-render time: ${Math.round((performance.now() - t) * 1000) / 1000}ms`,
        'dirtyLines:',
        dirtyLines.size,
        'linesChange:',
        linesChange
      );

      if (nextSelections !== undefined) {
        this.setSelections(nextSelections, false);
      }
    }

    if (this.#onChange !== undefined) {
      this.#onChange({ ...fileContents, contents: textDocument.getText() });
    }
  }

  #getThemeColorMap(themeType: 'dark' | 'light'): string[] {
    if (this.#highlighter === undefined || this.#file === undefined) {
      throw new Error('editor not initialized');
    }
    let themeName: string;
    const { theme = DEFAULT_THEMES } = this.#file.options;
    if (typeof theme === 'string') {
      themeName = theme;
    } else {
      themeName = theme[themeType];
    }
    this.#colorMap ??= new Map();
    let colorMap = this.#colorMap.get(themeName);
    if (colorMap === undefined) {
      const ret = this.#highlighter.setTheme(themeName);
      colorMap = ret.colorMap;
      this.#colorMap.set(themeName, ret.colorMap ?? []);
    }
    return colorMap;
  }

  #buildStateStackCache(
    textDocument: TextDocument,
    grammar: IGrammar,
    endLine: number
  ): StateStack {
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
      stateStackCache[line + 1] = state;
    }
    return stateStackCache[boundedEndLine] ?? INITIAL;
  }

  #isStateStackCacheSettled(
    previousStateStackCache: StateStack[] | undefined,
    line: number,
    state: StateStack
  ) {
    const previousNextState = previousStateStackCache?.[line + 1];
    return previousNextState !== undefined && state.equals(previousNextState);
  }

  #prebuildStateStackCache() {
    const textDocument = this.#textDocument;
    if (textDocument === undefined) {
      return;
    }
    const { startingLine = 0, totalLines = Infinity } = this.#renderRange ?? {};
    const endLine = Math.min(
      totalLines === Infinity ? Infinity : startingLine + totalLines,
      textDocument.lineCount
    );

    const grammar = this.#highlighter?.getLanguage(textDocument.languageId);
    if (grammar === undefined) {
      return;
    }

    this.#buildStateStackCache(textDocument, grammar, endLine);
  }

  #syncTextareaState() {
    const textDocument = this.#textDocument;
    const textareaEl = this.#textareaEl;
    const textareaSnapshot = this.#textareaSnapshot;
    if (
      textDocument === undefined ||
      textareaEl === undefined ||
      textareaSnapshot === undefined
    ) {
      return;
    }
    const { selectionStart, selectionEnd, value } = textareaEl;
    if (value !== textareaSnapshot.text) {
      // Text in the textarea has been changed.
      const change = resolveTextareaChange(
        textareaSnapshot,
        value,
        selectionStart,
        selectionEnd
      );
      this.#applyTextChange(change);
    } else if (this.#selections !== undefined) {
      // Selection in the textarea changed, but no text change was made.
      if (selectionStart === selectionEnd) {
        this.setSelections(
          mapSelectionMove(
            textDocument,
            this.#selections,
            textDocument.positionAt(textareaSnapshot.offset + selectionStart)
          ),
          false
        );
      } else {
        const isBackward =
          getSelectionDirectionFromTextarea(textareaEl) ===
          SelectionDirection.Backward;
        const anchorOffset =
          textareaSnapshot.offset +
          (isBackward ? selectionEnd : selectionStart);
        const focusOffset =
          textareaSnapshot.offset +
          (isBackward ? selectionStart : selectionEnd);
        this.setSelections(
          mapSelectionRangeMove(
            textDocument,
            this.#selections,
            textDocument.positionAt(anchorOffset),
            textDocument.positionAt(focusOffset)
          ),
          false
        );
      }
    }
  }

  #applyTextChange(change: ResolvedTextEdit) {
    if (this.#textDocument !== undefined && this.#selections !== undefined) {
      const nextSelections = applyTextChangeToSelections(
        this.#textDocument,
        this.#selections,
        change
      );
      this.#rerender(this.#textDocument, nextSelections);
    }
  }

  #updateTextarea(primarySelection: EditorSelection) {
    const textDocument = this.#textDocument;
    const textareaEl = this.#textareaEl;
    if (textDocument === undefined || textareaEl === undefined) {
      return;
    }
    const textareaSnapshot = createTextareaSnapshot(
      textDocument,
      primarySelection
    );
    const direction = toTextareaSelectionDirection(primarySelection);
    textareaEl.value = textareaSnapshot.text;
    textareaEl.style.transform = `translateY(${this.#getLineY(primarySelection.start.line)}px)`;
    textareaEl.setSelectionRange(
      textareaSnapshot.selectionStart,
      textareaSnapshot.selectionEnd,
      direction
    );
    this.#textareaSnapshot = textareaSnapshot;
    this.#shouldIgnoreSelectionChange = true;
    setTimeout(() => {
      this.#shouldIgnoreSelectionChange = false;
    }, 0);
  }

  // Check whether a selection overlaps the currently rendered line window.
  #isSelectionVisible(selection: EditorSelection): boolean {
    if (this.#renderRange === undefined) {
      return true;
    }
    const { start, end } = selection;
    const { startingLine, totalLines } = this.#renderRange;
    if (totalLines === Infinity) {
      return end.line >= startingLine;
    }
    const endLine = startingLine + totalLines;
    return start.line < endLine && end.line >= startingLine;
  }

  #renderSelections(
    selections: EditorSelection[],
    primarySelection: EditorSelection
  ) {
    const fragment = document.createDocumentFragment();
    const cacheMap = new Map<string, HTMLElement>();
    this.#file?.setSelectedLines(null);
    if (isCollapsedSelection(primarySelection)) {
      this.#file?.setSelectedLines({
        start: primarySelection.start.line + 1,
        end: primarySelection.end.line + 1,
      });
      this.#renderLineHighlight(primarySelection, fragment, cacheMap);
    }
    selections.forEach((selection) => {
      if (selections.length > 1 || !isCollapsedSelection(selection)) {
        this.#renderSelectionRange(selection, fragment, cacheMap);
      }
      this.#renderCaret(selection, fragment, cacheMap);
    });
    this.#contentEl?.append(fragment);
    this.#selectionEls?.forEach((el) => el.remove());
    this.#selectionEls?.clear();
    this.#selectionEls = cacheMap;
  }

  #renderLineHighlight(
    selection: EditorSelection,
    fragment: DocumentFragment,
    cacheMap: Map<string, HTMLElement>
  ) {
    if (!this.#isSelectionVisible(selection)) {
      return;
    }

    const cacheKey = `lineHighlight-${selection.start.line}`;
    if (this.#selectionEls?.has(cacheKey) === true) {
      const el = this.#selectionEls.get(cacheKey)!;
      this.#selectionEls.delete(cacheKey);
      cacheMap.set(cacheKey, el);
      return;
    }

    const hlEl = createElement(
      'div',
      {
        dataset: 'lineHighlight',
        style: {
          transform: `translateY(${this.#getLineY(selection.start.line)}px)`,
        },
      },
      fragment
    );
    cacheMap.set(cacheKey, hlEl);
  }

  #renderSelectionRange(
    selection: EditorSelection,
    fragment: DocumentFragment,
    cacheMap: Map<string, HTMLElement>
  ) {
    if (
      this.#textDocument === undefined ||
      !this.#isSelectionVisible(selection)
    ) {
      return;
    }

    const { start, end } = selection;
    const selectionEls = this.#selectionEls;

    for (let ln = start.line; ln <= end.line; ln++) {
      const lineText = this.#textDocument.getLineText(ln);
      const lineLength = lineText.length;
      const startChar = ln === start.line ? start.character : 0;
      const endChar = ln === end.line ? end.character : lineLength;
      const spacing =
        ln === end.line || startChar === endChar ? 0 : this.#charWidth;
      const cacheKey = `selection-${ln}-${startChar}-${endChar}`;

      let left = 0;
      let width = 0;
      let rangeEl: HTMLElement | undefined;
      if (startChar === endChar && startChar === 0) {
        left = this.#charWidth;
        width = ln === end.line ? 0 : this.#charWidth;
      } else {
        left = this.#getCharX(ln, startChar);
        width = endChar === startChar ? 0 : this.#getCharX(ln, endChar) - left;
      }

      const css = `width: ${width + spacing}px; transform: translateY(${this.#getLineY(ln)}px) translateX(${left}px);`;

      if (selectionEls?.has(cacheKey) === true) {
        rangeEl = selectionEls.get(cacheKey)!;
        selectionEls.delete(cacheKey);
        rangeEl.style.cssText = css;
      } else {
        for (const [key, el] of selectionEls?.entries() ?? []) {
          if (key.startsWith(`selection-${ln}-`)) {
            rangeEl = el;
            selectionEls?.delete(key);
            el.style.cssText = css;
            break;
          }
        }
      }

      rangeEl ??= createElement(
          'div',
          {
            dataset: 'selectionRange',
            style: { cssText: css },
          },
          fragment
        );

      cacheMap.set(cacheKey, rangeEl);
    }
  }

  #renderCaret(
    selection: EditorSelection,
    fragment: DocumentFragment,
    cacheMap: Map<string, HTMLElement>
  ) {
    if (!this.#isSelectionVisible(selection)) {
      return;
    }

    const { start, end, direction } = selection;
    const isBackward = direction === SelectionDirection.Backward;
    const line = isBackward ? start.line : end.line;
    const character = isBackward ? start.character : end.character;
    const left = Math.max(this.#charWidth, this.#getCharX(line, character));
    const caretEl = createElement(
      'div',
      {
        dataset: 'caret',
        style: {
          transform: `translateY(${this.#getLineY(line)}px) translateX(${left - 1}px)`,
        },
      },
      fragment
    );
    cacheMap.set('caret-' + line + '-' + character, caretEl);
  }

  async #runCommand(command: EditorCommand) {
    switch (command) {
      case 'selectAll':
        this.setSelections([this.#getFullSelection()]);
        break;

      case 'copy':
      case 'cut':
        if (
          this.#selections !== undefined &&
          this.#textDocument !== undefined
        ) {
          try {
            // todo: use navigator.clipboard.write() for multiple selections copy
            await navigator.clipboard.writeText(
              this.#getSelectionText(this.#selections)
            );
          } catch {
            return;
          }
          if (command === 'cut') {
            this.#replaceSelectionText('');
          }
        }
        break;

      case 'paste': {
        let text: string | string[];
        try {
          // todo: use navigator.clipboard.read() for multiple segments paste
          text = await navigator.clipboard.readText();
        } catch {
          return;
        }
        this.#replaceSelectionText(text);
        break;
      }

      case 'indent':
      case 'outdent':
        if (
          this.#selections !== undefined &&
          this.#textDocument !== undefined
        ) {
          const edits: TextEdit[] = [];
          const nextSelections: EditorSelection[] = [];
          for (const selection of this.#selections) {
            const startLine = selection.start.line;
            const outdent = command === 'outdent';
            if (startLine !== selection.end.line || outdent) {
              const ret = resolveIndentEdits(
                this.#textDocument,
                selection,
                this.#tabSize,
                outdent
              );
              edits.push(...ret[0]);
              nextSelections.push(ret[1]);
            } else {
              const lineChar0 = this.#textDocument.charAt({
                line: startLine,
                character: 0,
              });
              this.#replaceSelectionText(
                lineChar0 === '\t' ? '\t' : ' '.repeat(this.#tabSize)
              );
            }
          }
          if (edits.length > 0) {
            this.#textDocument.applyEdits(
              edits,
              true,
              this.#selections,
              nextSelections
            );
            this.#rerender(this.#textDocument, nextSelections);
          }
        }
        break;

      case 'documentStart':
      case 'documentEnd':
        this.setSelections([
          this.#getDocumentBoundarySelection(command === 'documentEnd'),
        ]);
        break;

      case 'undo':
        if (this.#textDocument?.canUndo === true) {
          const nextSelections = this.#textDocument.undo();
          this.#rerender(this.#textDocument, nextSelections);
        }
        break;

      case 'redo':
        if (this.#textDocument?.canRedo === true) {
          const nextSelections = this.#textDocument.redo();
          this.#rerender(this.#textDocument, nextSelections);
        }
        break;
    }
  }

  // for select all command
  #getFullSelection(): EditorSelection {
    const textDocument = this.#textDocument;
    if (textDocument === undefined) {
      throw new Error('Editor has no text document');
    }
    const lastLine = textDocument.lineCount - 1;
    const lastCharacter = textDocument.getLineText(lastLine)?.length ?? 0;
    return {
      start: { line: 0, character: 0 },
      end: { line: lastLine, character: lastCharacter },
      direction: SelectionDirection.Forward,
    };
  }

  // for documentStart/documentEnd commands
  #getDocumentBoundarySelection(atEnd: boolean): EditorSelection {
    const textDocument = this.#textDocument;
    if (textDocument === undefined) {
      throw new Error('Editor has no text document');
    }
    const line = atEnd ? textDocument.lineCount - 1 : 0;
    const character = atEnd ? (textDocument.getLineText(line)?.length ?? 0) : 0;
    const start = { line, character };
    return {
      start: start,
      end: start,
      direction: SelectionDirection.Forward,
    };
  }

  #getSelectionText(selections: readonly EditorSelection[]): string {
    if (this.#textDocument === undefined) {
      return '';
    }
    return [...selections]
      .sort((a, b) => {
        const startOrder = comparePosition(a.start, b.start);
        if (startOrder !== 0) {
          return startOrder;
        }
        return comparePosition(a.end, b.end);
      })
      .map((selection) => this.#textDocument!.getText(selection))
      .join('\n');
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
    // todo: normalize text with textDocument.EOF
    const nextSelections = Array.isArray(text)
      ? applyTextReplaceToSelections(textDocument, selections, text)
      : applyTextChangeToSelections(textDocument, selections, {
          start: textDocument.offsetAt(primarySelection.start),
          end: textDocument.offsetAt(primarySelection.end),
          text: text,
        });
    this.#rerender(textDocument, nextSelections);
  }

  #getLineElement(line: number) {
    return (
      this.#contentEl?.querySelector<HTMLDivElement>(
        `[data-line-index="${line}"]`
      ) ?? undefined
    );
  }

  // get line top position
  #getLineY(line: number) {
    const cachedY = this.#lineYCache.get(line);
    if (cachedY !== undefined) {
      return cachedY;
    }

    const y = this.#getLineElement(line)?.offsetTop ?? 0;
    this.#lineYCache.set(line, y);
    return y;
  }

  // get character left position in line
  #getCharX(line: number, character: number) {
    if (
      this.#lastCharX !== undefined &&
      this.#lastCharX[0] === line &&
      this.#lastCharX[1] === character
    ) {
      return this.#lastCharX[2];
    }

    const lineText = this.#textDocument?.getLineText(line);
    const paddingInline = this.#charWidth; // align to diff css: padding-inline: 1ch
    if (lineText === undefined || lineText.length === 0 || character <= 0) {
      return paddingInline;
    }

    const boundedCharacter = Math.min(character, lineText.length);
    const textBeforeCharacter = lineText.slice(0, boundedCharacter);
    const asciiWidth = this.#getExpandedAsciiTextWidth(textBeforeCharacter);

    let left = 0;
    if (asciiWidth !== -1 || this.#file?.options.overflow === 'wrap') {
      left = paddingInline + asciiWidth;
    } else {
      left = paddingInline + this.#measureTextWidth(textBeforeCharacter);
    }

    if (this.#lastCharX !== undefined) {
      this.#lastCharX[0] = line;
      this.#lastCharX[1] = character;
      this.#lastCharX[2] = left;
    } else {
      this.#lastCharX = [line, character, left];
    }

    return left;
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

  #getCSSProperites() {
    if (this.#contentEl === undefined) {
      return;
    }

    const { fontFamily, fontSize, lineHeight, tabSize } = getComputedStyle(
      this.#contentEl
    );

    const el = document.createElement('canvas');
    const ctx = el.getContext('2d');
    if (ctx !== null) {
      ctx.font = fontSize + ' ' + fontFamily;
      this.#measureCtx = ctx;
      this.#charWidth = Math.round(ctx.measureText('0').width * 1000) / 1000;
    } else {
      this.#measureCtx = undefined;
    }

    if (lineHeight.endsWith('px')) {
      this.#lineHeight = Number(lineHeight.slice(0, -2));
    } else if (fontSize.endsWith('px')) {
      this.#lineHeight =
        Number(fontSize.slice(0, -2)) * Number(lineHeight.slice(0, -2));
    }

    this.#tabSize = Number(tabSize);
  }

  // check if the web selection belongs to editor
  #selectionBelongsToEditor(composedRanges: StaticRange[]) {
    const contentEl = this.#contentEl;
    if (contentEl === undefined) {
      return false;
    }
    return composedRanges.every((range) => {
      return (
        contentEl.contains(range.startContainer) &&
        contentEl.contains(range.endContainer)
      );
    });
  }
}

export function edit<T>(file: File<T>): void {
  const editor = new Editor<T>();
  editor.edit(file);
}
