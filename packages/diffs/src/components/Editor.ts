import { EncodedTokenMetadata, type IGrammar, INITIAL } from 'shiki/textmate';

import { DEFAULT_THEMES } from '../constants';
import {
  type EditorCommand,
  isPrimaryModifier,
  resolveEditorCommandFromKeyboardEvent,
} from '../editor/editorCommand';
import {
  mapSelectionMove,
  mapSelectionTextChange,
  mapSelectionTextReplace,
} from '../editor/editorMultiSelections';
import {
  type NormalizedEditorOptions,
  normlizeEditorOptions,
} from '../editor/editorOptions';
import type {
  EditorSelection,
  EditorTextChange,
} from '../editor/editorSelection';
import {
  comparePosition,
  convertSelection,
  getPrimarySelection,
  isCollapsedSelection,
  resolveIndentEdits,
  SelectionDirection,
  selectionIntersects,
  toWebSelectionDirection,
} from '../editor/editorSelection';
import {
  addEventListener,
  createElement,
  extend,
  getLineIndentationUnit,
  getRootCssVariableValue,
  measureMonoFontWidth,
} from '../editor/editorUtils';
import {
  createEditSnippet,
  type EditSnippet,
  resolveTextChange,
} from '../editor/editSnippet';
import { TextDocument, type TextEdit } from '../editor/textDocument';
import {
  getHighlighterIfLoaded,
  getSharedHighlighter,
} from '../highlighter/shared_highlighter';
import { areThemesAttached } from '../highlighter/themes/areThemesAttached';
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
  #editSnippet?: EditSnippet;
  #typingBuffer?: { text: string; line: number };
  #typingBufferFlushTimeout?: ReturnType<typeof setTimeout>;
  #selections?: EditorSelection[];
  #reservedSelections?: EditorSelection[];
  #languageLoadRequestId = 0;
  #ignoreSelectionChange = false;

  #disposes?: (() => void)[];

  constructor(options: EditorOptions = {}) {
    this.#options = normlizeEditorOptions(options);
    this.#monoCharWidth = measureMonoFontWidth(
      'normal ' + this.#options.fontSize + 'px ' + this.#options.fontFamily
    );
    this.#gutterWidth = 0;
    this.#highlighter = areThemesAttached(options.theme ?? DEFAULT_THEMES)
      ? getHighlighterIfLoaded()
      : undefined;
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
    this.#editSnippet = undefined;
    this.#reservedSelections = undefined;
    this.#selections = undefined;
    this.#renderText(textDocument);
  }

  setThemeType(themeType: 'dark' | 'light' | 'system'): void {
    this.#options.themeType = themeType;
    this.#updateStyle();
    if (this.#textDocument !== undefined) {
      this.#renderText(this.#textDocument, this.#selections);
    }
  }

  render({ editorContainer }: { editorContainer: HTMLElement }): void {
    if (this.#editorEl !== undefined) {
      this.cleanUp();
    }
    const editorEl = createElement('div', {
      style: {
        position: 'relative',
        boxSizing: 'border-box',
        paddingTop: `${this.#options.paddingY}px`,
        paddingBottom: `${this.#options.paddingY}px`,
        fontFamily: this.#options.fontFamily,
        fontFeatureSettings: 'var(--diffs-font-features)',
        isolation: 'isolate',
      },
    });
    const textareaEl = createElement('textarea', { class: 'ť' }, editorEl);
    this.#editorEl = extend(editorEl, { tabIndex: this.#options.tabIndex });
    this.#styleEl = createElement('style', undefined, editorEl);
    this.#textareaEl = extend(textareaEl, {
      autocapitalize: 'off',
      autocomplete: 'off',
      autocorrect: false,
      spellcheck: false,
      wrap: 'off',
    });
    this.#disposes = [
      addEventListener(document, 'selectionchange', () => {
        if (this.#ignoreSelectionChange) {
          return;
        }

        const selectionRaw = document.getSelection();
        if (
          selectionRaw !== null &&
          this.#selectionBelongsToEditor(selectionRaw)
        ) {
          const selection = convertSelection(selectionRaw);
          if (selection !== null) {
            console.log('\n~~~~~~~~~', Math.round(Date.now() / 1000));
            console.log('document: selectionchange', selection);
            const reservedSelections = this.#reservedSelections;
            if (reservedSelections === undefined) {
              this.#restoreSelections([selection]);
              return;
            }
            this.#restoreSelections([
              ...reservedSelections.filter(
                (reservedSelection) =>
                  !selectionIntersects(reservedSelection, selection)
              ),
              selection,
            ]);
          }
        }
      }),

      addEventListener(editorEl, 'mousedown', (e) => {
        if (e.button === 0 && isPrimaryModifier(e)) {
          this.#reservedSelections = this.#selections?.map((selection) => ({
            ...selection,
          }));
        } else {
          this.#reservedSelections = undefined;
        }
      }),

      addEventListener(editorEl, 'mouseup', () => {
        this.#reservedSelections = undefined;
      }),

      addEventListener(editorEl, 'keydown', (e) => {
        if (this.#isTextareaElFocused !== true) {
          const command = resolveEditorCommandFromKeyboardEvent(e);
          if (command !== undefined) {
            this.#flushPendingTextareaChanges();
            e.preventDefault();
            void this.#runCommand(command);
            return;
          }
        }
        if (this.#isEditorElFocused === true) {
          textareaEl.focus();
        }
      }),

      addEventListener(editorEl, 'focus', () => {
        this.#isEditorElFocused = true;
      }),

      addEventListener(editorEl, 'blur', () => {
        this.#isEditorElFocused = false;
      }),

      addEventListener(textareaEl, 'focus', () => {
        this.#isTextareaElFocused = true;
      }),

      addEventListener(textareaEl, 'blur', () => {
        this.#isTextareaElFocused = false;
        this.#flushPendingTextareaChanges();
      }),

      addEventListener(textareaEl, 'keydown', (e) => {
        const command = resolveEditorCommandFromKeyboardEvent(e);
        if (command !== undefined) {
          this.#flushPendingTextareaChanges();
          e.preventDefault();
          void this.#runCommand(command);
        }
      }),

      // addEventListener(textareaEl, "input", () => {
      //   if (this.#ignoreSelectionChange) {
      //     return;
      //   }
      //   console.log("\n~~~~~~~~~", Math.round(Date.now() / 1000));
      //   console.log("textarea: input");
      //   this.#syncTextareaState();
      // }),

      addEventListener(textareaEl, 'selectionchange', () => {
        if (this.#ignoreSelectionChange) {
          return;
        }
        console.log('\n~~~~~~~~~', Math.round(Date.now() / 1000));
        console.log('textarea: selectionchange');
        this.#syncTextareaState();
      }),
    ];
    this.#highlighter ??= getSharedHighlighter(
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
    editorContainer.appendChild(editorEl);
  }

  public cleanUp(): void {
    this.#flushPendingTextareaChanges();
    this.#textLineEls?.clear();
    this.#selectionEls?.clear();
    this.#disposes?.forEach((dispose) => dispose());
    this.#editorEl?.remove();
    this.#activeLineEl = undefined;
    this.#disposes = undefined;
    this.#editorEl = undefined;
    this.#isEditorElFocused = false;
    this.#isTextareaElFocused = false;
    this.#reservedSelections = undefined;
    this.#selections = undefined;
    this.#selectionEls = undefined;
    this.#styleEl = undefined;
    this.#textareaEl = undefined;
    this.#editSnippet = undefined;
    this.#textLineEls = undefined;
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

    extend(editorEl.style, {
      color: foreground,
      backgroundColor: background,
    });
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
      ('.ť{position:absolute;left:var(--diffs-editor-gutter-width);z-index:-20;width:calc(100% - var(--diffs-editor-gutter-width));padding:0;' +
        `line-height:${lineHeight}px;` +
        'font:inherit;background-color:transparent;color:transparent;opacity:0;border:none;outline:none;resize:none}') +
      `.ń{display:inline-block;text-align:right;width:var(--diffs-editor-line-number-width);padding:0 ${this.#monoCharWidth}px;color:${lineNumberForeground};user-select:none;pointer-events:none;cursor:default}` +
      `.ǎ>.ń,.ǎ>.ď,.ǎ>.đ{color:${foreground}}` +
      (colorMap ?? [])
        .map((color, i) => `.ċ${i.toString(36)}{color:${color}}`)
        .join('') +
      '}';
  }

  // update gutter width
  #updateGutterWidth(totalLines: number) {
    const lineNumberDigits = totalLines.toString().length;
    const lineNumberWidth = Math.round(
      Math.max(this.#options.minNumberColumnWidth, lineNumberDigits) *
        this.#monoCharWidth
    );
    const lineNumberPadding = 2 * this.#monoCharWidth;
    this.#gutterWidth = lineNumberWidth + lineNumberPadding;
    this.#editorEl?.style.setProperty(
      '--diffs-editor-line-number-width',
      lineNumberWidth + 'px'
    );
    this.#editorEl?.style.setProperty(
      '--diffs-editor-gutter-width',
      this.#gutterWidth + 'px'
    );
  }

  #renderText(
    textDocument: TextDocument,
    selections?: EditorSelection[]
  ): void {
    const totalLines = textDocument.lineCount;
    const languageId = textDocument.languageId;

    this.#updateGutterWidth(totalLines);

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
      const lineLength = lineText.length;
      const preEl = createElement('pre', undefined, this.#editorEl);
      // oxlint-disable-next-line typescript/no-explicit-any
      (preEl as any).LINE = line;
      lineEls.set(line, preEl);

      const lineNumberEl = createElement('span', { class: 'ń' }, preEl);
      lineNumberEl.textContent = (line + 1).toString();

      if (grammar === undefined) {
        if (lineLength === 0) {
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
      if (result.stoppedEarly) {
        console.warn(
          `Time limit reached when tokenizing line: ${lineText.substring(0, 100)}`
        );
      }

      const tokens = result.tokens;
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

  #renderLine(line: string, offset: number) {
    console.log({ line, offset });
  }

  #syncTextareaState() {
    console.log('syncTextareaState');
    const textDocument = this.#textDocument;
    const textareaEl = this.#textareaEl;
    const editSnippet = this.#editSnippet;
    if (
      textDocument === undefined ||
      textareaEl === undefined ||
      editSnippet === undefined
    ) {
      return;
    }
    const { selectionStart, selectionEnd, value } = textareaEl;
    if (value !== editSnippet.text) {
      if (
        value.split('\n').length !== editSnippet.lines ||
        editSnippet.lines !== 3
      ) {
        const change = resolveTextChange(editSnippet, value);
        this.#applyTextChange(change);
      } else {
        const line = value.split('\n')[1];
        this.#renderLine(line, editSnippet.offset + selectionStart);
        this.#typingBuffer = { text: value, line: editSnippet.startLine };
        this.#typingBufferFlushTimeout = setTimeout(() => {
          this.#flushPendingTextareaChanges();
        }, 500);
      }
    } else if (
      selectionStart === selectionEnd &&
      this.#selections !== undefined
    ) {
      this.#restoreSelections(
        mapSelectionMove(
          textDocument,
          this.#selections,
          textDocument.positionAt(editSnippet.offset + selectionStart)
        )
      );
    }
  }

  #flushPendingTextareaChanges() {
    console.log('flushPendingTextareaChanges');
    if (this.#typingBufferFlushTimeout !== undefined) {
      window.clearTimeout(this.#typingBufferFlushTimeout);
      this.#typingBufferFlushTimeout = undefined;
    }
    if (this.#editSnippet !== undefined && this.#typingBuffer !== undefined) {
      const change = resolveTextChange(
        this.#editSnippet,
        this.#typingBuffer.text
      );
      this.#typingBuffer = undefined;
      this.#applyTextChange(change);
    }
  }

  #applyTextChange(change: EditorTextChange) {
    if (this.#textDocument !== undefined && this.#selections !== undefined) {
      const { edits, nextSelections: newSelections } = mapSelectionTextChange(
        this.#textDocument,
        this.#selections,
        change
      );
      this.#textDocument.applyEdits(
        edits,
        true,
        this.#selections,
        newSelections
      );
      this.#renderText(this.#textDocument, newSelections);
    }
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
    this.#updateTextarea(primarySelection);
  }

  #updateTextarea(primarySelection: EditorSelection) {
    console.log('updateTextarea');
    const textDocument = this.#textDocument;
    const textareaEl = this.#textareaEl;
    if (textDocument === undefined || textareaEl === undefined) {
      return;
    }
    const editSnippet = createEditSnippet(textDocument, primarySelection);
    this.#editSnippet = editSnippet;
    this.#ignoreSelectionChange = true;
    textareaEl.style.top =
      this.#getLineY(primarySelection.start.line - 1) + 'px';
    textareaEl.style.height =
      editSnippet.lines * this.#options.lineHeight + 'px';
    textareaEl.value = editSnippet.text;
    textareaEl.setSelectionRange(
      editSnippet.selectionStart,
      editSnippet.selectionEnd,
      toWebSelectionDirection(primarySelection.direction)
    );
    setTimeout(() => {
      console.log('^');
      this.#ignoreSelectionChange = false;
    }, 0);
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
      const startColumn = this.#getVisualColumn(lineText, startCharacter);
      const endColumns = this.#getVisualColumn(lineText, endCharacter);
      const startX = this.#getCharacterX(ln, startCharacter, startColumn);
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
    const column = this.#getVisualColumn(lineText, character);
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

  async #runCommand(command: EditorCommand) {
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
              this.#getSelectionText(this.#selections!)
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
      .join(this.#textDocument.EOF);
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
        });
    textDocument.applyEdits(edits, true, selections);
    this.#renderText(textDocument, nextSelections);
  }

  // get line Y position
  #getLineY(line: number) {
    return line * this.#options.lineHeight + this.#options.paddingY;
  }

  // get character X position
  // todo: support emoji/non-ascii chars
  #getCharacterX(line: number, character: number, visualColumn: number) {
    const fallbackLeft = this.#gutterWidth + visualColumn * this.#monoCharWidth;
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

  #getVisualColumn(text: string, character: number): number {
    const tabSize = this.#options.tabSize;
    let column = 0;
    for (let i = 0; i < Math.min(character, text.length); i++) {
      if (text.charCodeAt(i) === /* \t */ 9) {
        const remainder = column % tabSize;
        column += remainder === 0 ? tabSize : tabSize - remainder;
        continue;
      }
      column++;
    }
    return column;
  }

  // check if the web selection belongs to editor
  #selectionBelongsToEditor(selection: Selection) {
    const editorEl = this.#editorEl;
    return (
      editorEl !== undefined &&
      editorEl.contains(selection.anchorNode) === true &&
      editorEl !== selection.anchorNode &&
      editorEl.contains(selection.focusNode) === true &&
      editorEl !== selection.focusNode
    );
  }
}
