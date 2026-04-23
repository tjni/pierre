import { EncodedTokenMetadata, type IGrammar, INITIAL } from 'shiki/textmate';

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
  measureMonoFontWidth,
} from '../editor/editorUtils';
import {
  getOrderedSelectionText,
  mapSelectionRangeChange,
  mapSelectionTextChange,
  mapSelectionTextReplace,
} from '../editor/multiSelection';
import { normlizeEditorOptions } from '../editor/normlizeEditorOptions';
import type { IEditorSelection, ISelection } from '../editor/selection';
import {
  cloneSelection,
  convertSelection,
  createSelection,
  fromWebSelectionDirection,
  getPrimarySelection,
  isCollapsedSelection,
  normalizeSelections,
  SelectionDirection,
  toSelectionArray,
  toWebSelectionDirection,
} from '../editor/selection';
import {
  createTextareaSnippet,
  matchesTextareaState,
  resolveTextareaTextChange,
  type TextareaState,
} from '../editor/textareaState';
import { TextDocument } from '../editor/textDocument';
import { getVisualColumn } from '../editor/visualColumns';
import { getSharedHighlighter } from '../highlighter/shared_highlighter';
import type { BaseCodeOptions, DiffsHighlighter } from '../types';
import { getHighlighterOptions } from '../utils/getHighlighterOptions';

export interface EditorOptions extends BaseCodeOptions {
  tabIndex?: number;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  paddingY?: number;
}

export class Editor {
  #highlighter?: DiffsHighlighter;
  #colorMap?: string[];
  #textDocument?: TextDocument;

  // options
  #options: EditorOptions;
  #fontFamily: string;
  #fontSize: number;
  #lineHeightPx: number;
  #paddingY: number;
  #tabSize: number;
  #monoFontWidth: number;
  #lineNumberWidth: number;
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
  #selections?: ISelection[];
  #reservedSelections?: ISelection[];
  #languageLoadRequestId = 0;

  #disposes?: (() => void)[];

  constructor(options: EditorOptions = {}) {
    const { fontFamily, fontSize, lineHeight, paddingY, tabSize } =
      normlizeEditorOptions(options);
    this.#options = options;
    this.#fontFamily = fontFamily;
    this.#fontSize = fontSize;
    this.#lineHeightPx = Math.round(lineHeight);
    this.#paddingY = paddingY;
    this.#tabSize = tabSize;
    this.#monoFontWidth = measureMonoFontWidth(
      'normal ' + this.#fontSize + 'px ' + this.#fontFamily
    );
    this.#lineNumberWidth = Math.round(2 * this.#monoFontWidth);
    this.#gutterWidth = this.#lineNumberWidth; // currently the gutter width is equal to line number width
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

  setText(text: string, lang = 'plaintext'): void {
    this.setTextDocument(new TextDocument('inmemory://1', text, lang));
  }

  setTextDocument(textDocument: TextDocument): void {
    this.#textDocument = textDocument;
    this.#textareaState = undefined;
    this.#reservedSelections = undefined;
    const selection = createSelection(0, 0, 0, 0);
    this.#selections = [selection];
    void this.#renderText(textDocument, selection);
  }

  setThemeType(themeType: 'dark' | 'light' | 'system'): void {
    this.#options.themeType = themeType;
    this.#colorMap = undefined; // clear color map
    this.#updateStyle();
  }

  async render({
    editorContainer,
  }: {
    editorContainer: HTMLElement;
  }): Promise<void> {
    if (this.#editorEl !== undefined) {
      this.cleanUp();
    }
    const { tabIndex = -1 } = this.#options;
    const fontFamily = this.#fontFamily;
    const queueTextareaSync = coalesceMicrotask(() =>
      this.#syncTextareaState()
    );
    this.#editorEl = extend(
      createElement('div', {
        style: {
          position: 'relative',
          boxSizing: 'border-box',
          paddingTop: `${this.#paddingY}px`,
          paddingBottom: `${this.#paddingY}px`,
          fontFamily,
          isolation: 'isolate',
        },
      }),
      {
        tabIndex,
      }
    );
    this.#editorEl.style.setProperty(
      '--line-number-width',
      this.#lineNumberWidth + 'px'
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
            this.#restoreSelection(
              this.#reservedSelections !== undefined
                ? [...this.#reservedSelections, selection]
                : selection
            );
          }
        }
      }),
      addEventListener(this.#editorEl, 'mousedown', (e) => {
        if (e.button === 0 && getPrimaryModifier(e)) {
          this.#reservedSelections = this.#selections?.map(cloneSelection);
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
      }),
      addEventListener(document, 'keydown', (e) => {
        if (!this.#hasFocusWithinEditor()) {
          return;
        }
        if (this.#isTextareaElFocused !== true) {
          const command = resolveEditorShortcutCommand(e);
          if (command !== undefined) {
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
    this.#highlighter = await getSharedHighlighter(
      getHighlighterOptions(undefined, this.#options)
    );
    this.#updateStyle();
    if (this.#textDocument !== undefined) {
      void this.#renderText(this.#textDocument, this.#selections);
    }
    editorContainer.appendChild(this.#editorEl);
  }

  public cleanUp(): void {
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
    this.#reservedSelections = undefined;
  }

  #updateStyle() {
    const editorEl = this.#editorEl;
    const styleEl = this.#styleEl;
    const highlighter = this.#highlighter;
    if (
      editorEl === undefined ||
      styleEl === undefined ||
      highlighter === undefined
    ) {
      return;
    }

    let themeType = this.#options.themeType ?? 'system';
    let themeName = this.#options.theme;
    if (typeof themeName === 'string') {
      themeName = themeName as string;
    } else if (themeName !== undefined) {
      if (themeType === 'system') {
        themeType = window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
      }
      themeName = themeName[themeType];
    } else {
      themeName = highlighter.getLoadedThemes()[0];
    }

    let theme;
    if (this.#colorMap === undefined) {
      const ret = highlighter.setTheme(themeName);
      theme = ret.theme;
      this.#colorMap = ret.colorMap;
    } else {
      theme = highlighter.getTheme(themeName);
    }

    const fontSize = this.#fontSize;
    const lineHeightPx = this.#lineHeightPx;
    const colors = theme.colors ?? {};
    const foreground = theme.fg;
    const background = theme.bg;
    const selectionBackground = colors['editor.selectionBackground'];
    const lineHighlightBackground = colors['editor.lineHighlightBackground'];
    const lineNumberForeground =
      colors['editorLineNumber.foreground'] ?? colors.foreground;

    editorEl.style.color = foreground;
    editorEl.style.backgroundColor = background;
    styleEl.textContent =
      '@scope{' +
      '::selection{background-color:transparent}' +
      '@keyframes blinking{0%{opacity:0.9}50%{opacity:0}100%{opacity:0.9}}' +
      `pre{position:relative;margin:0;font:inherit;font-size:${fontSize}px;line-height:${lineHeightPx}px;cursor:text;white-space:pre;tab-size:${this.#tabSize}}` +
      `.ī{position:absolute;width:2px;height:${lineHeightPx}px;background-color:${foreground};pointer-events:none;animation:blinking 1.2s infinite;animation-delay:0.6s}` +
      `.š{position:absolute;z-index:-10;height:${lineHeightPx}px;background-color:${selectionBackground};pointer-events:none}` +
      (`.ħ{box-sizing:border-box;position:absolute;z-index:-10;width:100%;height:${lineHeightPx}px;` +
        (lineHighlightBackground !== undefined
          ? `background-color:${lineHighlightBackground}`
          : `border:2px solid ${selectionBackground}`) +
        ';pointer-events:none}') +
      ('.ť{position:absolute;z-index:-10;width:100%;padding:0;' +
        `line-height:${lineHeightPx}px;` +
        'font:inherit;background-color:transparent;color:transparent;opacity:0;border:none;outline:none;resize:none}') +
      `.ń{display:inline-block;text-align:right;width:var(--line-number-width);padding:0 ${this.#monoFontWidth}px;box-sizing:border-box;color:${lineNumberForeground};user-select:none;pointer-events:none;cursor:default}` +
      `.ǎ>.ń,.ǎ>.ď,.ǎ>.đ{color:${foreground}}` +
      this.#colorMap
        .map((color, i) => `.ċ${i.toString(36)}{color:${color}}`)
        .join('') +
      '}';
  }

  #setLineNumberDigits(lineNumberDigits: number) {
    this.#lineNumberWidth = Math.round(
      (lineNumberDigits + 2) * this.#monoFontWidth
    );
    this.#gutterWidth = this.#lineNumberWidth;
    this.#editorEl?.style.setProperty(
      '--line-number-width',
      this.#lineNumberWidth + 'px'
    );
  }

  #renderText(textDocument: TextDocument, selection?: IEditorSelection): void {
    const totalLines = textDocument.lineCount;
    const languageId = textDocument.languageId;

    const lineNumberDigits = Math.max(2, totalLines.toString().length);
    this.#setLineNumberDigits(lineNumberDigits);

    let grammar: IGrammar | undefined;
    if (this.#highlighter !== undefined) {
      if (this.#highlighter.getLoadedLanguages().includes(languageId)) {
        grammar = this.#highlighter.getLanguage(languageId);
      } else {
        const requestId = ++this.#languageLoadRequestId;
        void this.#highlighter.loadLanguage(languageId).then(() => {
          if (
            requestId !== this.#languageLoadRequestId ||
            this.#textDocument !== textDocument
          ) {
            return;
          }
          this.#renderText(textDocument, selection ?? this.#selections);
        });
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

    this.#restoreSelection(
      selection ?? this.#selections ?? createSelection(0, 0, 0, 0)
    );
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
      selection: selectionBefore,
      snippet: textareaSnippet,
      value: originalValue,
    } = textareaState;
    const { selectionStart, selectionEnd, selectionDirection, value } =
      textareaEl;
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
      const nextSelection =
        nextSelections.length === 1 ? nextSelections[0] : nextSelections;
      textDocument.applyEdits(edits, {
        selectionBefore:
          selectionsBefore.length === 1 ? selectionBefore : selectionsBefore,
      });
      textDocument.setLastUndoSelectionAfter(nextSelection);
      void this.#renderText(textDocument, nextSelection);
      // if (newChangedText.trim() && nextSelections.length === 1 && isCollapsedSelection(nextSelections[0]!)) {
      //   this.#langs.get(textDocument.languageId)?.lspDriver?.doComplete(textDocument, nextSelections[0]!.end);
      // }
    } else {
      const nextPrimarySelection = this.#createSelectionFromOffsets(
        snippetStartOffset + selectionStart,
        snippetStartOffset + selectionEnd,
        fromWebSelectionDirection(selectionDirection)
      );
      this.#restoreSelection(
        selectionsBefore.length > 1
          ? mapSelectionRangeChange(
              textDocument,
              selectionsBefore,
              nextPrimarySelection
            )
          : nextPrimarySelection
      );
    }
  }

  #restoreSelection(selection: IEditorSelection) {
    const selections = normalizeSelections(toSelectionArray(selection));
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
        this.#renderSelections(selection, selectionEls);
      }
      this.#renderCursor(selection, selectionEls);
    });
    this.#selectionEls?.forEach((el) => el.remove());
    this.#selectionEls?.clear();
    this.#selectionEls = selectionEls;
    this.#resetTextarea(primarySelection, selections);
  }

  #renderHighlightLine(
    selection: ISelection,
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

  #renderSelections(
    selection: ISelection,
    selectionEls: Map<string, HTMLElement>
  ) {
    const { start, end } = selection;
    for (let ln = start.line; ln <= end.line; ln++) {
      const lineText = this.#textDocument!.getLineText(ln) ?? '';
      const lineLength = lineText.length;
      const startCharacter = ln === start.line ? start.character : 0;
      const endCharacter = ln === end.line ? end.character : lineLength;
      const startColumn = getVisualColumn(
        lineText,
        startCharacter,
        this.#tabSize
      );
      const endColumn = getVisualColumn(lineText, endCharacter, this.#tabSize);
      const startX = this.#getCharacterX(ln, startCharacter, startColumn);
      const endX = this.#getCharacterX(ln, endCharacter, endColumn);
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

  #renderCursor(selection: ISelection, selectionEls: Map<string, HTMLElement>) {
    const { start, end, direction } = selection;
    const isBackward = direction === SelectionDirection.Backward;
    const lineText =
      this.#textDocument?.getLineText(isBackward ? start.line : end.line) ?? '';
    const line = isBackward ? start.line : end.line;
    const character = isBackward ? start.character : end.character;
    const column = getVisualColumn(lineText, character, this.#tabSize);
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

  #setActiveLine(selection: ISelection) {
    this.#activeLineEl?.classList.remove('ǎ');
    const activeLine =
      selection.direction === SelectionDirection.Backward
        ? selection.start.line
        : selection.end.line;
    const activeLineEl = this.#textLineEls?.get(activeLine);
    activeLineEl?.classList.add('ǎ');
    this.#activeLineEl = activeLineEl;
  }

  #resetTextarea(selection: ISelection, selections: ISelection[]) {
    const textDocument = this.#textDocument;
    const textareaEl = this.#textareaEl;
    if (textDocument === undefined || textareaEl === undefined) {
      return;
    }
    const textareaSnippet = createTextareaSnippet(textDocument, selection);
    this.#textareaState = {
      selections,
      selection,
      snippet: textareaSnippet,
      value: textareaSnippet.text,
    };
    textareaEl.value = textareaSnippet.text;
    textareaEl.setSelectionRange(
      textareaSnippet.selectionStart,
      textareaSnippet.selectionEnd,
      toWebSelectionDirection(selection.direction)
    );
    textareaEl.style.left = this.#gutterWidth + 'px';
    textareaEl.style.width = `calc(100% - ${this.#gutterWidth}px)`;
    textareaEl.style.top = this.#getLineY(textareaSnippet.firstLine) + 'px';
    textareaEl.style.height =
      textareaSnippet.text.split('\n').length * this.#lineHeightPx + 'px';
  }

  async #runShortcutCommand(command: EditorShortcutCommand) {
    switch (command) {
      case 'paste': {
        let text: string;
        try {
          text = await navigator.clipboard.readText();
        } catch {
          return;
        }
        this.#replaceSelectionText(
          this.#resolvePastedSelectionText(text) ?? text
        );
        break;
      }
      case 'copy':
      case 'cut':
        if (
          this.#selections !== undefined &&
          this.#textDocument !== undefined
        ) {
          try {
            await navigator.clipboard.writeText(
              getOrderedSelectionText(
                this.#textDocument,
                this.#selections
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
      case 'documentStart':
      case 'documentEnd':
        this.#restoreSelection(
          this.#getDocumentBoundarySelection(command === 'documentEnd')
        );
        break;
      case 'undo':
        if (this.#textDocument?.canUndo === true) {
          void this.#renderText(this.#textDocument, this.#textDocument.undo());
        }
        break;
      case 'redo':
        if (this.#textDocument?.canRedo === true) {
          void this.#renderText(this.#textDocument, this.#textDocument.redo());
        }
        break;
      case 'selectAll':
        this.#restoreSelection(this.#getSelectAllSelection());
        break;
    }
  }

  #getSelectAllSelection() {
    const textDocument = this.#textDocument;
    if (textDocument === undefined) {
      throw new Error('Editor has no text document');
    }
    const lastLine = textDocument.lineCount;
    const lastLineIndex = lastLine - 1;
    const lastCharacter = textDocument.getLineText(lastLineIndex)?.length ?? 0;
    return createSelection(
      0,
      0,
      lastLineIndex,
      lastCharacter,
      SelectionDirection.Forward
    );
  }

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
    const nextSelection =
      nextSelections.length === 1 ? nextSelections[0] : nextSelections;
    textDocument.applyEdits(edits, {
      selectionBefore: selections.length === 1 ? selection : selections,
    });
    textDocument.setLastUndoSelectionAfter(nextSelection);
    void this.#renderText(textDocument, nextSelection);
  }

  #getDocumentBoundarySelection(atEnd: boolean) {
    const textDocument = this.#textDocument;
    if (textDocument === undefined) {
      throw new Error('Editor has no text document');
    }
    const line = atEnd ? textDocument.lineCount - 1 : 0;
    const character = atEnd ? (textDocument.getLineText(line)?.length ?? 0) : 0;
    return createSelection(line, character, line, character);
  }

  #resolvePastedSelectionText(text: string) {
    const selectionCount = this.#selections?.length ?? 0;
    if (selectionCount === 0) {
      return undefined;
    }
    const parts = text.split(/\r\n?|\n/g);
    return parts.length === selectionCount ? parts : undefined;
  }

  #getLineY(line: number) {
    return line * this.#lineHeightPx + this.#paddingY;
  }

  #getCharacterX(line: number, character: number, visualColumn: number) {
    const fallbackLeft = this.#gutterWidth + visualColumn * this.#monoFontWidth;
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

  #hasFocusWithinEditor() {
    const activeElement = document.activeElement;
    return (
      activeElement === this.#editorEl ||
      activeElement === this.#textareaEl ||
      (activeElement !== null &&
        this.#editorEl?.contains(activeElement) === true)
    );
  }

  #selectionBelongsToEditor(selection: Selection) {
    return (
      this.#nodeBelongsToEditor(selection.anchorNode) &&
      this.#nodeBelongsToEditor(selection.focusNode)
    );
  }

  #nodeBelongsToEditor(node: Node | null) {
    return node !== null && this.#editorEl?.contains(node) === true;
  }
}
