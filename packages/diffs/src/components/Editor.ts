import { EncodedTokenMetadata, type IGrammar, INITIAL } from 'shiki/textmate';

import {
  type NormalizedEditorOptions,
  normlizeEditorOptions,
} from '../editor/editorOptions';
import {
  type EditorShortcutCommand,
  getPrimaryModifier,
  resolveEditorShortcutCommand,
} from '../editor/editorShortcuts';
import {
  addEventListener,
  coalesceMicrotask,
  createElement,
  extend,
  getLineIndentationUnit,
  getRootCssVariableValue,
  measureMonoFontWidth,
} from '../editor/editorUtils';
import {
  getOrderedSelectionText,
  mapSelectionRangeChange,
  mapSelectionTextChange,
  mapSelectionTextReplace,
} from '../editor/multiSelection';
import type { EditorSelection } from '../editor/selection';
import {
  convertSelection,
  createSelection,
  fromWebSelectionDirection,
  getPrimarySelection,
  isCollapsedSelection,
  resolveIndentEdits,
  SelectionDirection,
  toWebSelectionDirection,
} from '../editor/selection';
import {
  createTextareaSnippet,
  matchesTextareaState,
  resolveTextareaTextChange,
  type TextareaState,
} from '../editor/textareaState';
import { TextDocument, type TextEdit } from '../editor/textDocument';
import { getVisualColumns } from '../editor/visualColumns';
import { getSharedHighlighter } from '../highlighter/shared_highlighter';
import type {
  BaseCodeOptions,
  DiffsHighlighter,
  ThemeRegistrationResolved,
} from '../types';
import { getHighlighterOptions } from '../utils/getHighlighterOptions';

export interface EditorOptions extends BaseCodeOptions {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  paddingY?: number;
  tabIndex?: number;
  tabSize?: number;
  minNumberColumnWidth?: number;
}

export class Editor {
  #options: NormalizedEditorOptions;
  #highlighter?: DiffsHighlighter | Promise<DiffsHighlighter>;
  #textDocument?: TextDocument;

  // computed width values
  #monoCharWidth: number;
  #gutterWidth: number;

  // dom elements
  #editorEl?: HTMLElement;
  #styleEl?: HTMLStyleElement;
  #textareaEl?: HTMLTextAreaElement;
  #activeLineEl?: HTMLElement;
  #textLineEls?: Map<number, HTMLElement>;
  #selectionEls?: Map<string, HTMLElement>;

  // state
  #isEditorElFocused?: boolean;
  #isTextareaElFocused?: boolean;
  #textareaState?: TextareaState;
  #pendingTextareaSnapshot?: {
    value: string;
    selectionStart: number;
    selectionEnd: number;
    selectionDirection: HTMLTextAreaElement['selectionDirection'];
  };
  #typingFlushTimeout?: number;
  #selections?: EditorSelection[];
  #reservedSelections?: EditorSelection[];
  #languageLoadRequestId = 0;

  #disposes?: (() => void)[];

  constructor(options: EditorOptions = {}) {
    this.#options = normlizeEditorOptions(options);
    this.#monoCharWidth = measureMonoFontWidth(
      'normal ' + this.#options.fontSize + 'px ' + this.#options.fontFamily
    );
    this.#gutterWidth = 0;
  }

  get options(): EditorOptions {
    return this.#options;
  }

  get text(): string | undefined {
    return this.#textDocument?.getText();
  }

  get textDocument(): TextDocument | undefined {
    return this.#textDocument;
  }

  get #hasSelection(): boolean {
    return this.#selections !== undefined && this.#selections.length > 0;
  }

  setText(text: string, lang = 'plaintext'): void {
    this.setTextDocument(new TextDocument('inmemory://1', text, lang));
  }

  setTextDocument(textDocument: TextDocument): void {
    this.#textDocument = textDocument;
    this.#textareaState = undefined;
    this.#reservedSelections = undefined;
    this.#selections = undefined;
    this.#renderText(textDocument);
  }

  setThemeType(themeType: 'dark' | 'light' | 'system'): void {
    this.#options.themeType = themeType;
    this.#updateStyle();
  }

  render({ editorContainer }: { editorContainer: HTMLElement }): void {
    if (this.#editorEl !== undefined) {
      this.cleanUp();
    }
    const { tabIndex = -1 } = this.#options;
    const queueTextareaSync = coalesceMicrotask(() =>
      this.#syncTextareaState()
    );
    this.#editorEl = extend(
      createElement('div', {
        style: {
          position: 'relative',
          boxSizing: 'border-box',
          paddingTop: `${this.#options.paddingY}px`,
          paddingBottom: `${this.#options.paddingY}px`,
          fontFamily: this.#options.fontFamily,
          fontFeatureSettings: 'var(--diffs-font-features)',
          isolation: 'isolate',
        },
      }),
      {
        tabIndex,
      }
    );
    this.#styleEl = createElement('style', undefined, this.#editorEl);
    this.#textareaEl = extend(
      createElement('textarea', { class: 'ť' }, this.#editorEl),
      {
        autocapitalize: 'off',
        autocomplete: 'off',
        autocorrect: false,
        spellcheck: false,
        wrap: 'off',
      }
    );
    this.#disposes = [
      addEventListener(document, 'selectionchange', () => {
        const selectionRaw = document.getSelection();
        if (
          selectionRaw !== null &&
          this.#selectionBelongsToEditor(selectionRaw)
        ) {
          const selection = convertSelection(selectionRaw);
          if (selection !== null) {
            this.#restoreSelections([
              ...(this.#reservedSelections ?? []),
              selection,
            ]);
          }
        }
      }),
      addEventListener(this.#editorEl, 'mousedown', (e) => {
        if (e.button === 0 && getPrimaryModifier(e)) {
          this.#reservedSelections = this.#selections?.map((selection) => ({
            ...selection,
          }));
        }
      }),
      addEventListener(document, 'mouseup', () => {
        this.#reservedSelections = undefined;
      }),
      addEventListener(this.#editorEl, 'focus', () => {
        this.#isEditorElFocused = true;
      }),
      addEventListener(this.#editorEl, 'blur', () => {
        this.#isEditorElFocused = false;
      }),
      addEventListener(this.#textareaEl, 'focus', () => {
        this.#isTextareaElFocused = true;
      }),
      addEventListener(this.#textareaEl, 'blur', () => {
        this.#isTextareaElFocused = false;
        this.#flushPendingTextareaChanges();
      }),
      addEventListener(document, 'keydown', (e) => {
        if (!this.#hasFocusWithinEditor()) {
          return;
        }
        if (this.#isTextareaElFocused !== true) {
          const command = resolveEditorShortcutCommand(e);
          if (command !== undefined) {
            this.#flushPendingTextareaChanges();
            e.preventDefault();
            void this.#runShortcutCommand(command);
            return;
          }
        }
        if (
          this.#isTextareaElFocused !== true &&
          this.#isEditorElFocused === true &&
          e.key !== 'Shift' &&
          e.key !== 'Control' &&
          e.key !== 'Alt' &&
          e.key !== 'Meta'
        ) {
          this.#textareaEl?.focus();
        }
      }),
      addEventListener(this.#textareaEl, 'keydown', (e) => {
        const command = resolveEditorShortcutCommand(e);
        if (command !== undefined) {
          this.#flushPendingTextareaChanges();
          e.preventDefault();
          void this.#runShortcutCommand(command);
        }
      }),
      addEventListener(this.#textareaEl, 'input', queueTextareaSync),
      addEventListener(this.#textareaEl, 'selectionchange', () => {
        if (
          this.#textareaState !== undefined &&
          this.#textareaEl !== undefined &&
          matchesTextareaState(this.#textareaState, this.#textareaEl)
        ) {
          return;
        }
        queueTextareaSync();
      }),
    ];
    this.#highlighter = getSharedHighlighter(
      getHighlighterOptions(undefined, this.#options)
    ).then((highlighter) => {
      this.#highlighter = highlighter;
      this.#updateStyle();
      return highlighter;
    });
    this.#updateStyle();
    if (this.#textDocument !== undefined) {
      this.#renderText(this.#textDocument, this.#selections);
    }
    editorContainer.appendChild(this.#editorEl);
  }

  public cleanUp(): void {
    this.#clearTypingFlushTimeout();
    this.#textLineEls?.clear();
    this.#selectionEls?.clear();
    this.#disposes?.forEach((dispose) => dispose());
    this.#editorEl?.remove();
    this.#editorEl = undefined;
    this.#styleEl = undefined;
    this.#textareaEl = undefined;
    this.#activeLineEl = undefined;
    this.#textLineEls = undefined;
    this.#selectionEls = undefined;
    this.#disposes = undefined;
    this.#isEditorElFocused = false;
    this.#isTextareaElFocused = false;
    this.#textareaState = undefined;
    this.#pendingTextareaSnapshot = undefined;
    this.#reservedSelections = undefined;
  }

  #updateStyle() {
    const editorEl = this.#editorEl;
    const styleEl = this.#styleEl;
    const options = this.#options;
    if (editorEl === undefined || styleEl === undefined) {
      return;
    }

    let themeName: string | undefined;
    let theme: ThemeRegistrationResolved | undefined;
    let colorMap: string[] | undefined;
    if (typeof options.theme === 'string') {
      themeName = options.theme;
    } else if (typeof options.theme === 'object' && options.theme !== null) {
      let themeType = options.themeType ?? 'system';
      if (themeType === 'system') {
        themeType = window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
      }
      themeName = options.theme[themeType];
    }
    if (
      this.#highlighter !== undefined &&
      !(this.#highlighter instanceof Promise)
    ) {
      themeName ??= this.#highlighter.getLoadedThemes()[0];
      ({ theme, colorMap } = this.#highlighter.setTheme(themeName));
    }

    const colors = theme?.colors ?? {};
    const foreground =
      theme?.fg ??
      colors['editor.foreground'] ??
      getRootCssVariableValue('--diffs-fg') ??
      '';
    const background =
      theme?.bg ??
      colors['editor.background'] ??
      getRootCssVariableValue('--diffs-bg') ??
      '';
    const selectionBackground =
      colors['editor.selectionBackground'] ?? 'rgba(128,128,128,0.05)';
    const lineNumberForeground =
      colors['editorLineNumber.foreground'] ?? colors.foreground;
    const lineHighlightBackground = colors['editor.lineHighlightBackground'];
    const { lineHeight, fontSize, tabSize } = this.#options;

    editorEl.style.color = foreground;
    editorEl.style.backgroundColor = background;
    styleEl.textContent =
      '@scope{' +
      '::selection{background-color:transparent}' +
      '@keyframes blinking{0%{opacity:0.9}50%{opacity:0}100%{opacity:0.9}}' +
      `pre{position:relative;margin:0;font:inherit;font-size:${fontSize}px;line-height:${lineHeight}px;cursor:text;white-space:pre;tab-size:${tabSize}}` +
      `.ī{position:absolute;width:2px;height:${lineHeight}px;background-color:${foreground};pointer-events:none;animation:blinking 1.2s infinite;animation-delay:0.6s}` +
      `.š{position:absolute;z-index:-10;height:${lineHeight}px;background-color:${selectionBackground};pointer-events:none}` +
      (`.ħ{box-sizing:border-box;position:absolute;z-index:-10;width:100%;height:${lineHeight}px;` +
        (lineHighlightBackground !== undefined
          ? `background-color:${lineHighlightBackground}`
          : `border:2px solid ${selectionBackground}`) +
        ';pointer-events:none}') +
      ('.ť{position:absolute;z-index:-20;width:100%;padding:0;' +
        `line-height:${lineHeight}px;` +
        'font:inherit;background-color:transparent;color:transparent;opacity:0;border:none;outline:none;resize:none}') +
      `.ń{display:inline-block;text-align:right;width:var(--diffs-editor-line-number-width);padding:0 ${this.#monoCharWidth}px;color:${lineNumberForeground};user-select:none;pointer-events:none;cursor:default}` +
      `.ǎ>.ń,.ǎ>.ď,.ǎ>.đ{color:${foreground}}` +
      (colorMap ?? [])
        .map((color, i) => `.ċ${i.toString(36)}{color:${color}}`)
        .join('') +
      '}';
  }

  #renderText(
    textDocument: TextDocument,
    selections?: EditorSelection[]
  ): void {
    const totalLines = textDocument.lineCount;
    const languageId = textDocument.languageId;

    // update gutter width
    const lineNumberDigits = totalLines.toString().length;
    const lineNumberWidth = Math.round(
      Math.max(this.#options.minNumberColumnWidth, lineNumberDigits) *
        this.#monoCharWidth
    );
    const lineNumberPadding = 2 * this.#monoCharWidth;
    this.#editorEl?.style.setProperty(
      '--diffs-editor-line-number-width',
      lineNumberWidth + 'px'
    );
    this.#gutterWidth = lineNumberWidth + lineNumberPadding;

    let grammar: IGrammar | undefined;
    const highlighter = this.#highlighter;
    if (highlighter !== undefined) {
      const loadLanguage = async (highlighter: DiffsHighlighter) => {
        const requestId = ++this.#languageLoadRequestId;
        await highlighter.loadLanguage(languageId);
        if (
          requestId === this.#languageLoadRequestId &&
          this.#textDocument === textDocument
        ) {
          this.#renderText(textDocument, selections);
        }
      };
      if (highlighter instanceof Promise) {
        void highlighter.then(loadLanguage);
      } else if (highlighter.getLoadedLanguages().includes(languageId)) {
        grammar = highlighter.getLanguage(languageId);
      } else {
        void loadLanguage(highlighter);
      }
    }

    const lineEls = new Map<number, HTMLElement>();
    for (let line = 0, ruleStack = INITIAL; line < totalLines; line++) {
      const lineText = textDocument.getLineText(line) ?? '';
      const preEl = createElement('pre', undefined, this.#editorEl);
      // oxlint-disable-next-line typescript/no-explicit-any
      (preEl as any).LINE = line;
      lineEls.set(line, preEl);

      const lineNumberEl = createElement('span', { class: 'ń' }, preEl);
      lineNumberEl.textContent = (line + 1).toString();

      if (grammar === undefined) {
        if (lineText.length === 0) {
          createElement('br', undefined, preEl);
          continue;
        }
        const span = createElement('span', undefined, preEl);
        span.textContent = lineText;
        // oxlint-disable-next-line typescript/no-explicit-any
        (span as any).CHAR = 0;
        continue;
      }

      const result = grammar.tokenizeLine2(lineText, ruleStack);
      const tokens = result.tokens;
      const lineLength = lineText.length;
      const tokensLength = tokens.length / 2;
      for (let j = 0; j < tokensLength; j++) {
        const offset = tokens[2 * j];
        const nextOffset =
          j + 1 < tokensLength ? tokens[2 * j + 2] : lineLength;
        if (offset === nextOffset) {
          createElement('br', undefined, preEl);
          continue;
        }
        const metadata = tokens[2 * j + 1];
        const span = createElement(
          'span',
          {
            class:
              'ċ' + EncodedTokenMetadata.getForeground(metadata).toString(36),
          },
          preEl
        );
        // oxlint-disable-next-line typescript/no-explicit-any
        (span as any).CHAR = offset;
        span.textContent = lineText.slice(offset, nextOffset);
      }

      ruleStack = result.ruleStack;
    }

    // clear previous line elements
    this.#textLineEls?.forEach((el) => {
      el.remove();
      el.onmouseover = null;
      el.onmouseleave = null;
    });
    this.#textLineEls?.clear();
    this.#textLineEls = lineEls;
    this.#activeLineEl = undefined;

    if (selections !== undefined) {
      this.#restoreSelections(selections);
    }
  }

  #createSelectionFromOffsets(
    startOffset: number,
    endOffset = startOffset,
    direction = SelectionDirection.None
  ) {
    const textDocument = this.#textDocument!;
    const start = textDocument.positionAt(startOffset);
    const end = textDocument.positionAt(endOffset);
    return createSelection(
      start.line,
      start.character,
      end.line,
      end.character,
      direction
    );
  }

  #syncTextareaState() {
    const textDocument = this.#textDocument;
    const textareaEl = this.#textareaEl;
    const textareaState = this.#textareaState;
    if (
      textDocument === undefined ||
      textareaEl === undefined ||
      textareaState === undefined
    ) {
      return;
    }
    const {
      selections: selectionsBefore,
      primarySelection: selectionBefore,
      snippet: textareaSnippet,
      value: originalValue,
    } = textareaState;
    const pendingSnapshot = this.#pendingTextareaSnapshot;
    const { selectionStart, selectionEnd, selectionDirection, value } =
      pendingSnapshot ?? textareaEl;
    const snippetStartOffset = textDocument.offsetAt({
      line: textareaSnippet.firstLine,
      character: 0,
    });
    if (value !== originalValue) {
      const {
        start: oldChangedStart,
        end: oldChangedEnd,
        text: newChangedText,
        selectionStart: nextSelectionStart,
        selectionEnd: nextSelectionEnd,
      } = resolveTextareaTextChange({
        documentValue: textDocument.getText(),
        originalValue,
        value,
        originalSelectionStart: textareaSnippet.selectionStart,
        originalSelectionEnd: textareaSnippet.selectionEnd,
        selectionStart,
        selectionEnd,
      });
      const { edits, nextSelections } = mapSelectionTextChange(
        textDocument,
        selectionsBefore,
        {
          start: snippetStartOffset + oldChangedStart,
          end: snippetStartOffset + oldChangedEnd,
          text: newChangedText,
          selectionStart: snippetStartOffset + nextSelectionStart,
          selectionEnd: snippetStartOffset + nextSelectionEnd,
          direction: fromWebSelectionDirection(selectionDirection),
        }
      );
      const isBufferedTypingChange =
        pendingSnapshot === undefined &&
        selectionsBefore.length === 1 &&
        isCollapsedSelection(selectionBefore) &&
        nextSelections.length === 1 &&
        isCollapsedSelection(nextSelections[0]) &&
        selectionStart === selectionEnd;
      if (isBufferedTypingChange) {
        this.#pendingTextareaSnapshot = {
          value,
          selectionStart,
          selectionEnd,
          selectionDirection,
        };
        this.#scheduleTypingFlush();
        return;
      }
      this.#applyResolvedTextareaChange(
        edits,
        selectionsBefore,
        nextSelections
      );
      // if (newChangedText.trim() && nextSelections.length === 1 && isCollapsedSelection(nextSelections[0]!)) {
      //   this.#langs.get(textDocument.languageId)?.lspDriver?.doComplete(textDocument, nextSelections[0]!.end);
      // }
    } else {
      const nextPrimarySelection = this.#createSelectionFromOffsets(
        snippetStartOffset + selectionStart,
        snippetStartOffset + selectionEnd,
        fromWebSelectionDirection(selectionDirection)
      );
      this.#restoreSelections(
        mapSelectionRangeChange(
          textDocument,
          selectionsBefore,
          nextPrimarySelection
        )
      );
    }
  }

  #scheduleTypingFlush() {
    this.#clearTypingFlushTimeout();
    this.#typingFlushTimeout = window.setTimeout(() => {
      this.#typingFlushTimeout = undefined;
      this.#flushPendingTextareaChanges();
    }, 300);
  }

  #clearTypingFlushTimeout() {
    if (this.#typingFlushTimeout !== undefined) {
      window.clearTimeout(this.#typingFlushTimeout);
      this.#typingFlushTimeout = undefined;
    }
  }

  #flushPendingTextareaChanges() {
    const textDocument = this.#textDocument;
    const textareaState = this.#textareaState;
    const pendingSnapshot = this.#pendingTextareaSnapshot;
    if (
      textDocument === undefined ||
      textareaState === undefined ||
      pendingSnapshot === undefined
    ) {
      return;
    }
    this.#clearTypingFlushTimeout();
    const {
      selections: selectionsBefore,
      snippet: textareaSnippet,
      value: originalValue,
    } = textareaState;
    const { value, selectionStart, selectionEnd, selectionDirection } =
      pendingSnapshot;
    const snippetStartOffset = textDocument.offsetAt({
      line: textareaSnippet.firstLine,
      character: 0,
    });
    const {
      start: oldChangedStart,
      end: oldChangedEnd,
      text: newChangedText,
      selectionStart: nextSelectionStart,
      selectionEnd: nextSelectionEnd,
    } = resolveTextareaTextChange({
      documentValue: textDocument.getText(),
      originalValue,
      value,
      originalSelectionStart: textareaSnippet.selectionStart,
      originalSelectionEnd: textareaSnippet.selectionEnd,
      selectionStart,
      selectionEnd,
    });
    const { edits, nextSelections } = mapSelectionTextChange(
      textDocument,
      selectionsBefore,
      {
        start: snippetStartOffset + oldChangedStart,
        end: snippetStartOffset + oldChangedEnd,
        text: newChangedText,
        selectionStart: snippetStartOffset + nextSelectionStart,
        selectionEnd: snippetStartOffset + nextSelectionEnd,
        direction: fromWebSelectionDirection(selectionDirection),
      }
    );
    this.#pendingTextareaSnapshot = undefined;
    this.#applyResolvedTextareaChange(edits, selectionsBefore, nextSelections);
  }

  #applyResolvedTextareaChange(
    edits: TextEdit[],
    selectionsBefore: EditorSelection[],
    nextSelections: EditorSelection[]
  ) {
    const textDocument = this.#textDocument;
    if (textDocument === undefined) {
      return;
    }
    textDocument.applyEdits(edits, true, selectionsBefore);
    this.#renderText(textDocument, nextSelections);
  }

  #restoreSelections(selections: EditorSelection[]) {
    const primarySelection = getPrimarySelection(selections);
    if (primarySelection === undefined) {
      return;
    }
    this.#selections = selections;
    const selectionEls = new Map<string, HTMLElement>();
    this.#setActiveLine(primarySelection);
    if (isCollapsedSelection(primarySelection)) {
      this.#renderHighlightLine(primarySelection, selectionEls);
    }
    selections.forEach((selection) => {
      if (!isCollapsedSelection(selection)) {
        this.#renderSelectionRange(selection, selectionEls);
      }
      this.#renderCursor(selection, selectionEls);
    });
    this.#selectionEls?.forEach((el) => el.remove());
    this.#selectionEls?.clear();
    this.#selectionEls = selectionEls;
    this.#updateTextarea(primarySelection, selections);
  }

  #renderHighlightLine(
    selection: EditorSelection,
    selectionEls: Map<string, HTMLElement>
  ) {
    const hlEl = createElement(
      'div',
      {
        class: 'ħ',
        style: {
          top: this.#getLineY(selection.start.line) + 'px',
        },
      },
      this.#editorEl
    );
    hlEl.scrollIntoView({ block: 'nearest' });
    selectionEls.set(`highlightLine-${selection.start.line}`, hlEl);
  }

  #renderSelectionRange(
    selection: EditorSelection,
    selectionEls: Map<string, HTMLElement>
  ) {
    const { start, end } = selection;
    for (let ln = start.line; ln <= end.line; ln++) {
      const lineText = this.#textDocument!.getLineText(ln) ?? '';
      const lineLength = lineText.length;
      const startCharacter = ln === start.line ? start.character : 0;
      const endCharacter = ln === end.line ? end.character : lineLength;
      const startColumns = getVisualColumns(
        lineText,
        startCharacter,
        this.#options.tabSize
      );
      const endColumns = getVisualColumns(
        lineText,
        endCharacter,
        this.#options.tabSize
      );
      const startX = this.#getCharacterX(ln, startCharacter, startColumns);
      const endX = this.#getCharacterX(ln, endCharacter, endColumns);
      const spacing =
        endCharacter === startCharacter || ln === end.line ? 0 : 4;
      const style = {
        top: this.#getLineY(ln) + 'px',
        left: startX + 'px',
        width: Math.max(endX - startX, 1) + spacing + 'px',
      };
      const selectionEl = createElement(
        'div',
        { class: 'š', style },
        this.#editorEl
      );
      selectionEls.set(
        `selection-${ln}-${startCharacter}-${endCharacter}`,
        selectionEl
      );
    }
  }

  #renderCursor(
    selection: EditorSelection,
    selectionEls: Map<string, HTMLElement>
  ) {
    const { start, end, direction } = selection;
    const isBackward = direction === SelectionDirection.Backward;
    const lineText =
      this.#textDocument?.getLineText(isBackward ? start.line : end.line) ?? '';
    const line = isBackward ? start.line : end.line;
    const character = isBackward ? start.character : end.character;
    const column = getVisualColumns(lineText, character, this.#options.tabSize);
    const left = this.#getCharacterX(line, character, column);
    const cursorEl = createElement(
      'div',
      {
        class: 'ī',
        style: {
          top: this.#getLineY(line) + 'px',
          left: left + 'px',
        },
      },
      this.#editorEl
    );
    selectionEls.set(
      'cursor-' + line + '-' + character + '-' + direction,
      cursorEl
    );
  }

  #setActiveLine(selection: EditorSelection) {
    this.#activeLineEl?.classList.remove('ǎ');
    const activeLine =
      selection.direction === SelectionDirection.Backward
        ? selection.start.line
        : selection.end.line;
    const activeLineEl = this.#textLineEls?.get(activeLine);
    activeLineEl?.classList.add('ǎ');
    this.#activeLineEl = activeLineEl;
  }

  #updateTextarea(
    primarySelection: EditorSelection,
    selections: EditorSelection[]
  ) {
    const textDocument = this.#textDocument;
    const textareaEl = this.#textareaEl;
    if (textDocument === undefined || textareaEl === undefined) {
      return;
    }
    const textareaSnippet = createTextareaSnippet(
      textDocument,
      primarySelection
    );
    this.#textareaState = {
      selections,
      primarySelection,
      snippet: textareaSnippet,
      value: textareaSnippet.text,
    };
    this.#pendingTextareaSnapshot = undefined;
    textareaEl.value = textareaSnippet.text;
    textareaEl.setSelectionRange(
      textareaSnippet.selectionStart,
      textareaSnippet.selectionEnd,
      toWebSelectionDirection(primarySelection.direction)
    );
    textareaEl.style.left = this.#gutterWidth + 'px';
    textareaEl.style.width = `calc(100% - ${this.#gutterWidth}px)`;
    textareaEl.style.top = this.#getLineY(textareaSnippet.firstLine) + 'px';
    textareaEl.style.height =
      textareaSnippet.text.split('\n').length * this.#options.lineHeight + 'px';
  }

  async #runShortcutCommand(command: EditorShortcutCommand) {
    switch (command) {
      case 'selectAll':
        this.#restoreSelections([this.#getFullSelection()]);
        break;

      case 'copy':
      case 'cut':
        if (this.#hasSelection && this.#textDocument !== undefined) {
          try {
            // todo: use navigator.clipboard.write() for multiple selections copy
            await navigator.clipboard.writeText(
              getOrderedSelectionText(
                this.#textDocument,
                this.#selections!
              ).join(this.#textDocument.EOF)
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
        if (this.#hasSelection && this.#textDocument !== undefined) {
          const edits: TextEdit[] = [];
          const nextSelections: EditorSelection[] = [];
          for (const selection of this.#selections!) {
            const startLine = selection.start.line;
            const lineText = this.#textDocument.getLineText(startLine);
            if (lineText !== undefined) {
              const outdent = command === 'outdent';
              if (startLine !== selection.end.line || outdent) {
                const ret = resolveIndentEdits(
                  this.#textDocument,
                  selection,
                  this.#options.tabSize,
                  outdent
                );
                edits.push(...ret[0]);
                nextSelections.push(ret[1]);
              } else {
                const indentUnit = getLineIndentationUnit(
                  lineText,
                  this.#options.tabSize
                );
                this.#replaceSelectionText(indentUnit);
              }
            }
          }
          if (edits.length > 0) {
            this.#textDocument.applyEdits(
              edits,
              true,
              this.#selections,
              nextSelections
            );
            this.#renderText(this.#textDocument, nextSelections);
          }
        }
        break;

      case 'documentStart':
      case 'documentEnd':
        this.#restoreSelections([
          this.#getDocumentBoundarySelection(command === 'documentEnd'),
        ]);
        break;

      case 'undo':
        if (this.#textDocument?.canUndo === true) {
          this.#renderText(this.#textDocument, this.#textDocument.undo());
        }
        break;

      case 'redo':
        if (this.#textDocument?.canRedo === true) {
          this.#renderText(this.#textDocument, this.#textDocument.redo());
        }
        break;
    }
  }

  // for select all command
  #getFullSelection() {
    const textDocument = this.#textDocument;
    if (textDocument === undefined) {
      throw new Error('Editor has no text document');
    }
    const lastLine = textDocument.lineCount - 1;
    const lastCharacter = textDocument.getLineText(lastLine)?.length ?? 0;
    return createSelection(
      0,
      0,
      lastLine,
      lastCharacter,
      SelectionDirection.Forward
    );
  }

  // for documentStart/documentEnd commands
  #getDocumentBoundarySelection(atEnd: boolean) {
    const textDocument = this.#textDocument;
    if (textDocument === undefined) {
      throw new Error('Editor has no text document');
    }
    const line = atEnd ? textDocument.lineCount - 1 : 0;
    const character = atEnd ? (textDocument.getLineText(line)?.length ?? 0) : 0;
    return createSelection(line, character, line, character);
  }

  // replace the selection text
  #replaceSelectionText(text: string | string[]) {
    const selections = this.#selections;
    if (selections === undefined) {
      return;
    }
    const textDocument = this.#textDocument;
    const selection = getPrimarySelection(selections);
    if (textDocument == null || selection == null) {
      return;
    }
    const normalizedText = Array.isArray(text)
      ? text.map((value) => value.replace(/\r\n?|\n/g, textDocument.EOF))
      : text.replace(/\r\n?|\n/g, textDocument.EOF);
    const { edits, nextSelections } = Array.isArray(normalizedText)
      ? mapSelectionTextReplace(textDocument, selections, normalizedText)
      : mapSelectionTextChange(textDocument, selections, {
          start: textDocument.offsetAt(selection.start),
          end: textDocument.offsetAt(selection.end),
          text: normalizedText,
          selectionStart:
            textDocument.offsetAt(selection.start) + normalizedText.length,
          selectionEnd:
            textDocument.offsetAt(selection.start) + normalizedText.length,
          direction: SelectionDirection.None,
        });
    textDocument.applyEdits(edits, true, selections);
    this.#renderText(textDocument, nextSelections);
  }

  // get line Y position
  #getLineY(line: number) {
    return line * this.#options.lineHeight + this.#options.paddingY;
  }

  // get character X position
  // todo: does it support emoji/non-ascii input?
  #getCharacterX(line: number, character: number, visualColumns: number) {
    const fallbackLeft =
      this.#gutterWidth + visualColumns * this.#monoCharWidth;
    const lineEl = this.#textLineEls?.get(line);
    const editorEl = this.#editorEl;
    if (lineEl === undefined || editorEl === undefined) {
      return fallbackLeft;
    }

    let targetSpan: HTMLElement | undefined;
    let targetOffset = 0;
    let lastSpan: HTMLElement | undefined;
    let lastEnd = 0;
    const children = lineEl.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!(child instanceof HTMLElement) || child.tagName !== 'SPAN') {
        continue;
      }
      // oxlint-disable-next-line typescript/no-explicit-any
      const start = (child as any).CHAR as number | undefined;
      if (start === undefined) {
        continue;
      }
      const textLength = child.textContent?.length ?? 0;
      const end = start + textLength;
      if (character >= start && character <= end) {
        targetSpan = child;
        targetOffset = character - start;
        break;
      }
      if (end >= lastEnd) {
        lastSpan = child;
        lastEnd = end;
      }
    }

    const range = document.createRange();
    if (targetSpan !== undefined) {
      const textNode = targetSpan.firstChild;
      if (textNode === null) {
        return fallbackLeft;
      }
      const nodeLength = textNode.textContent?.length ?? 0;
      const boundedOffset = Math.max(0, Math.min(targetOffset, nodeLength));
      range.setStart(textNode, boundedOffset);
      range.setEnd(textNode, boundedOffset);
    } else if (lastSpan !== undefined) {
      const textNode = lastSpan.firstChild;
      if (textNode === null) {
        return fallbackLeft;
      }
      const nodeLength = textNode.textContent?.length ?? 0;
      range.setStart(textNode, nodeLength);
      range.setEnd(textNode, nodeLength);
    } else {
      return fallbackLeft;
    }

    const editorRect = editorEl.getBoundingClientRect();
    const pointRect = range.getBoundingClientRect();
    return pointRect.left - editorRect.left;
  }

  // check if the active element has focus within editor
  #hasFocusWithinEditor() {
    const activeElement = document.activeElement;
    if (activeElement === null) {
      return false;
    }
    return (
      activeElement === this.#editorEl ||
      activeElement === this.#textareaEl ||
      this.#editorEl?.contains(activeElement) === true
    );
  }

  // check if the web selection belongs to editor
  #selectionBelongsToEditor(selection: Selection) {
    return (
      this.#editorEl?.contains(selection.anchorNode) === true &&
      this.#editorEl?.contains(selection.focusNode) === true
    );
  }
}
