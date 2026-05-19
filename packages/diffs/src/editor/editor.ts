import type { File } from '../components/File';
import { DEFAULT_THEMES } from '../constants';
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
  DiffsEditorSearchParams,
  DiffsEditorSelection,
  FileContents,
  HighlightedToken,
  LineAnnotation,
  RenderRange,
} from '../types';
import { getFiletypeFromFileName } from '../utils/getFiletypeFromFileName';
import {
  type EditorCommand,
  resolveEditorCommandFromKeyboardEvent,
} from './command';
import { editorCSS } from './css';
import { applyDocumentChangeToLineAnnotations } from './lineAnnotations';
import { isPrimaryModifier } from './platform';
import { QuickEdit } from './quickEdit';
import type { EditorSelection } from './selection';
import {
  applyTextChangeToSelections,
  applyTextReplaceToSelections,
  comparePosition,
  convertSelection,
  createSelectionFrom,
  createSelectionFromAnchorAndFocusOffsets,
  DirectionBackward,
  DirectionForward,
  DirectionNone,
  expandCollapsedSelectionToWord,
  extendSelection,
  extendSelections,
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
} from './selection';
import { EditorTokenizer, renderLineTokens } from './tokenzier';
import { addEventListener, debounce, extend, h, round } from './utils';

export interface EditorOptions<LAnnotation> {
  enabledQuickEdit?: boolean;
  renderQuickEdit?: (context: {
    selection: EditorSelection;
    textDocument: TextDocument<LAnnotation>;
    replaceSelectionText: (text: string) => void;
    close: () => void;
  }) => HTMLElement;
}

export class Editor<LAnnotation> implements DiffsEditor<LAnnotation> {
  options: EditorOptions<LAnnotation>;

  // event handlers
  #editorEventDisposes?: (() => void)[];
  #globalEventDisposes?: (() => void)[];
  #onChange?: (
    file: FileContents,
    lineAnnotations?: LineAnnotation<LAnnotation>[]
  ) => void;

  // metrics
  #charWidth = -1;
  #lineHeight = 20;
  #tabSize = 2;
  #wrap = false;

  // file
  #component?: DiffsEditableComponent<LAnnotation>;
  #fileContents?: FileContents;
  #lineAnnotations?: LineAnnotation<LAnnotation>[];
  #textDocument?: TextDocument<LAnnotation>;
  #renderRange?: RenderRange;

  // highlighter
  #tokenizer?: EditorTokenizer;

  // cache
  #lineYCache = new Map<number, number>();
  #wrapLineOffsetsCache = new Map<number, Uint32Array>();
  #lastCharX?: [line: number, character: number, x: number, wrapLine: number];
  #lastContentWidth = -1;
  #lastGutterWidth = -1;

  // dom
  #fileContainer?: HTMLElement;
  #contentElement?: HTMLElement;
  #styleElement?: HTMLStyleElement;
  #overlayElement?: HTMLElement;
  #searchPanelElement?: HTMLElement;
  #selectionElements?: Map<string, HTMLElement>;
  #primaryCaretElement?: HTMLElement;
  #quickEdit?: QuickEdit;
  #measureCtx?: CanvasRenderingContext2D;
  #contentResizeObserver?: ResizeObserver;

  // state
  #shouldIgnoreSelectionChange = false;
  #isMouseDown = false;
  #shiftKeyPressed = false;
  #selectionStart: EditorSelection | undefined;
  #reservedSelections?: EditorSelection[];
  #selections?: EditorSelection[];
  #scrollingToLine?: number;
  #scrollingForceFocus?: boolean;
  #retainSearchPanelFocus = false;

  #emitChange = debounce(
    (
      fileContents: FileContents,
      lineAnnotations?: LineAnnotation<LAnnotation>[]
    ) => {
      this.#onChange?.(fileContents, lineAnnotations);
    },
    500
  );

  #onDeferTokenize = (
    lines: Map<number, Array<HighlightedToken>>,
    themeType: 'light' | 'dark'
  ) => {
    this.#component?.emitTokenize(lines, themeType);
    // update the view if the render range is updated by scrolling
    // and the deferred tokenized lines inside the render range
    if (
      this.#renderRange !== undefined &&
      this.#renderRange.totalLines !== Infinity
    ) {
      const { startingLine, totalLines } = this.#renderRange;
      const endLine = Math.min(
        startingLine + totalLines,
        this.#textDocument?.lineCount ?? 0
      );
      for (const [line, tokens] of lines) {
        if (line >= startingLine && line < endLine) {
          const lineElement = this.#getLineElement(line);
          if (lineElement !== undefined) {
            lineElement.replaceChildren(...renderLineTokens(tokens, themeType));
          }
        }
      }
    }
  };

  constructor(options: EditorOptions<LAnnotation> = {}) {
    this.options = options;
  }

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
    this.#globalEventDisposes?.forEach((dispose) => dispose());
    this.#globalEventDisposes = undefined;
    this.#editorEventDisposes?.forEach((dispose) => dispose());
    this.#editorEventDisposes = undefined;
    this.#onChange = undefined;

    this.#component?.setSelectedLines(null);
    this.#component?.removeEditor();
    this.#component = undefined;
    this.#fileContents = undefined;
    this.#lineAnnotations = undefined;
    this.#textDocument = undefined;
    this.#renderRange = undefined;

    this.#tokenizer?.stopBackgroundTokenize();
    this.#tokenizer = undefined;

    this.#lineYCache.clear();
    this.#wrapLineOffsetsCache.clear();
    this.#lastCharX = undefined;
    this.#lastContentWidth = -1;
    this.#lastGutterWidth = -1;

    this.#fileContainer = undefined;
    this.#contentElement?.removeAttribute('contentEditable');
    this.#contentElement = undefined;
    this.#styleElement?.remove();
    this.#styleElement = undefined;
    this.#overlayElement?.remove();
    this.#overlayElement = undefined;
    this.#searchPanelElement = undefined;
    this.#selectionElements?.forEach((el) => el.remove());
    this.#selectionElements?.clear();
    this.#selectionElements = undefined;
    this.#primaryCaretElement = undefined;
    this.#quickEdit?.cleanup();
    this.#quickEdit = undefined;
    this.#measureCtx = undefined;
    this.#contentResizeObserver?.disconnect();
    this.#contentResizeObserver = undefined;

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
    const shadowRoot = fileContainer.shadowRoot ?? undefined;
    const contentEl =
      shadowRoot?.querySelector<HTMLElement>('[data-content]') ?? undefined;
    const highlighter = areThemesAttached(
      this.#component?.options.theme ?? DEFAULT_THEMES
    )
      ? getHighlighterIfLoaded()
      : undefined;
    if (
      shadowRoot === undefined ||
      contentEl === undefined ||
      highlighter === undefined
    ) {
      throw new Error('Could not edit the file.');
    }

    this.#wrap = this.#component?.options.overflow === 'wrap';

    if (this.#fileContainer !== fileContainer) {
      const shadowRoot = fileContainer.shadowRoot;
      this.#fileContainer = fileContainer;
      if (shadowRoot !== null && this.#styleElement !== undefined) {
        shadowRoot.appendChild(this.#styleElement);
      }
    }

    if (this.#contentElement !== contentEl) {
      const targetIsContentElement = (e: Event) => {
        const target = e.composedPath()[0];
        return target === this.#contentElement;
      };
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
      this.#editorEventDisposes?.forEach((dispose) => dispose());
      this.#editorEventDisposes = [
        addEventListener(
          contentEl,
          'keydown',
          (e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              this.#searchPanelElement?.remove();
              this.#searchPanelElement = undefined;
              this.#retainSearchPanelFocus = false;
              this.#quickEdit?.cleanup();
              this.#quickEdit = undefined;
              return;
            }
            if (!targetIsContentElement(e)) {
              return;
            }
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
            if (!targetIsContentElement(e)) {
              return;
            }
            e.preventDefault();
            e.clipboardData?.setData('text', this.#getSelectionText());
          },
          { passive: false }
        ),

        addEventListener(
          contentEl,
          'cut',
          (e) => {
            if (!targetIsContentElement(e)) {
              return;
            }
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
            if (!targetIsContentElement(e)) {
              return;
            }
            e.preventDefault();
            const text = e.clipboardData?.getData('text');
            if (text !== undefined) {
              // TODO(@ije): Add support of multiple selections copy&paste
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
            if (!targetIsContentElement(e)) {
              return;
            }
            e.preventDefault();
            this.#handleInput(e.inputType, e.data);
          },
          { passive: false }
        ),

        addEventListener(
          contentEl,
          'compositionstart',
          (e) => {
            if (!targetIsContentElement(e)) {
              return;
            }
            this.#shouldIgnoreSelectionChange = true;
          },
          { passive: true }
        ),

        addEventListener(
          contentEl,
          'compositionend',
          (e) => {
            if (!targetIsContentElement(e)) {
              return;
            }
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
    this.#lastGutterWidth = this.#getGutterWidth();
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
      const textDocument = new TextDocument<LAnnotation>(
        fileContents.name,
        fileContents.contents,
        fileContents.lang ?? getFiletypeFromFileName(fileContents.name)
      );
      this.#fileContents = fileContents;
      this.#textDocument = textDocument;
      this.#tokenizer?.stopBackgroundTokenize();
      this.#tokenizer = new EditorTokenizer({
        highlighter,
        theme: this.#getTheme(),
        textDocument,
        tokenizeMaxLineLength:
          this.#component?.options.tokenizeMaxLineLength ?? 1000,
        onDeferTokenize: this.#onDeferTokenize,
      });
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
    this.#tokenizer?.prebuildStateStackMap(renderRange);

    if (this.#selections !== undefined && this.#selections.length > 0) {
      // when re-rendering triggered by viewport scroll,
      // re-render the existing selections
      this.#updateSelections(this.#selections, true);
    }

    if (renderRange !== undefined) {
      const { startingLine, totalLines } = renderRange;
      console.log(
        '[diffs/editor] render file:',
        fileContents.name,
        'RenderRange:',
        startingLine + '-' + totalLines,
        'of',
        this.#textDocument.lineCount,
        'lines'
      );
    }

    if (this.#scrollingToLine !== undefined) {
      this.#scrollToLine(this.#scrollingToLine, this.#scrollingForceFocus);
    }

    if (this.#retainSearchPanelFocus) {
      this.#retainSearchPanelFocus = false;
      requestAnimationFrame(() => {
        this.#focusSearchPanelInput();
      });
    }

    if (
      this.#quickEdit !== undefined &&
      this.#isLineVisible(this.#quickEdit.line) &&
      this.#contentElement !== undefined
    ) {
      this.#quickEdit.render(this.#contentElement);
    }
  }

  #getTheme(): {
    name: string;
    type: 'dark' | 'light';
  } {
    let { themeType = 'system', theme = DEFAULT_THEMES } =
      this.#component?.options ?? {};
    if (themeType === 'system') {
      themeType = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    return {
      name: typeof theme === 'string' ? theme : theme[themeType],
      type: themeType,
    };
  }

  #initialize(): void {
    this.#styleElement = h('style', {
      dataset: 'editorCss',
      textContent: editorCSS,
    });

    this.#overlayElement = h('div', {
      dataset: 'editorOverlay',
    });

    this.#globalEventDisposes = [
      addEventListener(
        document,
        'selectionchange',
        () => {
          const shadowRoot = this.#fileContainer?.shadowRoot;
          if (this.#shouldIgnoreSelectionChange || shadowRoot == null) {
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
          this.#selectionElements?.forEach((el, key) => {
            if (key.startsWith('quickEditIcon-')) {
              el.dataset.visible = 'true';
            }
          });
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

  // TODO(@ije): add command registry
  #runCommand(command: EditorCommand) {
    const textDocument = this.#textDocument;
    if (textDocument === undefined) {
      return;
    }

    switch (command) {
      case 'openSearchPanel':
        this.#renderSearchPanel();
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

      case 'selectAll':
        this.#updateSelections([getDocumentFullSelection(textDocument)]);
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

      case 'expandSelectionDocStart':
      case 'expandSelectionDocEnd':
        {
          const atEnd = command === 'expandSelectionDocEnd';
          const selections = this.#selections;
          if (selections !== undefined && selections.length > 0) {
            this.#updateSelections(
              extendSelections(
                selections,
                getDocumentBoundarySelection(textDocument, atEnd)
              ),
              true
            );
            this.#scrollToLine(atEnd ? textDocument.lineCount - 1 : 0, true);
          }
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
    const gutterWidth = this.#getGutterWidth();
    const contentWidthChanged = contentWidth !== this.#lastContentWidth;
    const gutterWidthChanged = gutterWidth !== this.#lastGutterWidth;
    this.#lastContentWidth = contentWidth;
    this.#lastGutterWidth = gutterWidth;
    if (!contentWidthChanged && !gutterWidthChanged) {
      return;
    }

    this.#lastCharX = undefined;
    if (this.#wrap && contentWidthChanged) {
      this.#lineYCache.clear();
      this.#wrapLineOffsetsCache.clear();
    }
    if (this.#selections !== undefined) {
      this.#updateSelections(this.#selections);
    }
  }

  #rerender(
    change: TextDocumentChange,
    nextLineAnnotations?: LineAnnotation<LAnnotation>[] | undefined
  ) {
    const tokenizer = this.#tokenizer;
    const component = this.#component;
    const fileContents = this.#fileContents;
    const textDocument = this.#textDocument;
    const contentEl = this.#contentElement;
    const gutterEl = this.#contentElement?.previousElementSibling ?? undefined;
    if (
      tokenizer === undefined ||
      component === undefined ||
      fileContents === undefined ||
      textDocument === undefined ||
      contentEl === undefined ||
      gutterEl === undefined ||
      !(gutterEl instanceof HTMLElement) ||
      gutterEl.dataset.gutter === undefined
    ) {
      return;
    }

    // cancel existing background tokenzier task
    tokenizer.stopBackgroundTokenize();

    const dirtyLines = tokenizer.tokenize(change, this.#renderRange);
    const t = performance.now();

    if (dirtyLines.size > 0) {
      const children = contentEl.children;
      const dirtyLineIndexes = new Set<number>(dirtyLines.keys());
      const startingLine = this.#renderRange?.startingLine ?? 0;

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
              ...renderLineTokens(tokens, tokenizer.themeType)
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
          h(
            'div',
            {
              dataset: {
                line: lineNumber,
                lineType: 'context',
                lineIndex: lineIndex.toString(),
              },
              // oxlint-disable-next-line react/no-children-prop
              children: renderLineTokens(tokens, tokenizer.themeType),
            },
            contentEl
          );
          h(
            'div',
            {
              dataset: {
                lineType: 'context',
                columnNumber: lineNumber,
                lineIndex: lineIndex.toString(),
              },
              // oxlint-disable-next-line react/no-children-prop
              children: [
                h('span', {
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

    component.emitTokenize(dirtyLines, tokenizer.themeType);
    if (change.lineDelta !== 0) {
      gutterEl.style.gridRow = 'span ' + gutterEl.children.length;
      contentEl.style.gridRow = 'span ' + gutterEl.children.length;
      component.emitLineCountChange(textDocument, nextLineAnnotations);
    }

    console.log(
      `[diffs/editor] re-render time: ${Math.round((performance.now() - t) * 1000) / 1000}ms`,
      'lastChange:',
      change,
      'dirtyLines:',
      dirtyLines.size
    );
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
      const line = primarySelection.start.line + 1;
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
    for (const selection of selections) {
      if (!isCollapsedSelection(selection)) {
        this.#renderSelection(renderCtx, selection);
      }
      this.#renderCaret(renderCtx, selection, selection === primarySelection);
    }
    if (
      this.options.enabledQuickEdit === true &&
      !isCollapsedSelection(primarySelection)
    ) {
      this.#renderQuickEditIcon(renderCtx, primarySelection);
    }
    this.#overlayElement?.appendChild(fragment);
    requestAnimationFrame(() => {
      this.#selectionElements?.forEach((el) => el.remove());
      this.#selectionElements?.clear();
      this.#selectionElements = renderCtx.elements;
      if (updateWindowSelection) {
        this.#updateWindowSelection(primarySelection);
      }
    });
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
      this.#scrollToLine(isBackward ? start.line : end.line, false);
    }
  }

  #scrollToLine(line: number, forceFocus = false) {
    const lineElement = this.#getLineElement(line);
    if (lineElement !== undefined) {
      const scrollToLine = () => {
        lineElement.scrollIntoView({ block: 'center', inline: 'start' });
        if (forceFocus) {
          requestAnimationFrame(() => {
            this.#contentElement?.focus({ preventScroll: true });
          });
        }
      };
      if (this.#scrollingToLine !== undefined) {
        this.#scrollingToLine = undefined;
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
      const anchor = h('span', {
        style: {
          position: 'absolute',
          top: approximateLineY + 'px',
          left: '0',
          width: '1px',
          height: '1px',
        },
      });
      this.#contentElement?.getRootNode()?.appendChild(anchor);
      this.#scrollingToLine = line;
      this.#scrollingForceFocus = forceFocus;
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
      rangeEl = h(
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
    const caretEl = h(
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

  #renderQuickEditIcon(
    renderCtx: {
      fragment: DocumentFragment;
      elements: Map<string, HTMLElement>;
    },
    selection: EditorSelection
  ) {
    const line =
      selection.direction === DirectionBackward
        ? selection.start.line
        : selection.end.line;
    if (!this.#isLineVisible(line)) {
      return;
    }

    const [left, wrapLine] = this.#getCharX(line, 0);
    const cacheKey = 'quickEditIcon-' + line + '(' + wrapLine + ')';
    if (renderCtx.elements.has(cacheKey)) {
      return;
    }

    const quickEditIcon = QuickEdit.renderIcon(
      left,
      this.#getLineY(line) + wrapLine * this.#lineHeight,
      renderCtx.fragment,
      () => {
        const cleanUpQuickEdit = () => {
          this.#quickEdit?.cleanup();
          this.#quickEdit = undefined;
        };

        const handleResize = () => {
          // the line y cache is invalidated by the DOM change,
          // clear the line y cache and rerender the selection
          this.#lineYCache.clear();
          if (this.#selections !== undefined) {
            this.#updateSelections(this.#selections, true);
          }
        };

        // remove the existing quick edit element
        cleanUpQuickEdit();

        const textDocument = this.#textDocument;
        const renderQuickEdit = this.options.renderQuickEdit;
        const fileContainer = this.#fileContainer;
        if (
          textDocument === undefined ||
          renderQuickEdit === undefined ||
          fileContainer == null
        ) {
          return;
        }

        const line = selection.start.line;
        const lineText = textDocument.getLineText(line);
        const quickEditElement = renderQuickEdit({
          textDocument,
          selection: selection,
          close: () => {
            cleanUpQuickEdit();
            handleResize();
          },
          replaceSelectionText: (text: string) => {
            this.#replaceSelectionText(text);
          },
        });
        let leadingWhitespaces = 0;
        for (let i = 0; i < lineText.length; i++) {
          const charCode = lineText.charCodeAt(i);
          if (charCode === /* space */ 32) {
            leadingWhitespaces++;
          } else if (charCode === /* tab */ 9) {
            leadingWhitespaces += this.#tabSize;
          } else {
            break;
          }
        }
        this.#selections = [selection];
        this.#quickEdit = new QuickEdit(
          line,
          quickEditElement,
          fileContainer,
          leadingWhitespaces,
          handleResize
        );
        if (this.#isLineVisible(line) && this.#contentElement !== undefined) {
          this.#quickEdit.render(this.#contentElement);
        }
      }
    );
    renderCtx.elements.set(cacheKey, quickEditIcon);
  }

  #renderSearchPanel() {
    this.#searchPanelElement?.remove();

    const textDocument = this.#textDocument;
    const selections = this.#selections;
    const preElement =
      this.#fileContainer?.shadowRoot?.querySelector<HTMLElement>('pre');
    if (
      textDocument === undefined ||
      selections === undefined ||
      preElement == null
    ) {
      return;
    }

    const primaryIndex = selections.length - 1;
    let primarySelection = selections[primaryIndex];
    if (isCollapsedSelection(primarySelection)) {
      const expanded = expandCollapsedSelectionToWord(
        textDocument,
        primarySelection
      );
      const nextSelections = [...selections.slice(0, primaryIndex), expanded];
      this.#updateSelections(nextSelections, true);
      primarySelection = expanded;
    }
    const selectionText = textDocument.getText(primarySelection);

    const defaultQuery = !selectionText.includes('\n') ? selectionText : '';
    const searchParams: DiffsEditorSearchParams = {
      text: defaultQuery,
      replaceText: '',
      caseSensitive: false,
      wholeWord: true,
      regex: false,
      action: 'findNext',
    };
    let allMatches: [number, number][] = [];
    const updateAllMatches = () => {
      allMatches =
        searchParams.text !== ''
          ? textDocument.search({ ...searchParams, action: 'findAll' })
          : [];
      searchPanel
        .querySelectorAll<HTMLElement>('[data-disabled]')
        .forEach((element) => {
          element.dataset.disabled = String(allMatches.length === 0);
        });
    };
    const inputElement = h('input', {
      type: 'text',
      placeholder: 'Search',
      dataset: 'search',
      value: defaultQuery,
      oninput: (e: Event) => {
        searchParams.text = (e.target as HTMLInputElement).value;
        updateAllMatches();
        this.#updateSearchMatches(allMatches, searchParams.text);
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.#searchPanelElement?.remove();
          this.#searchPanelElement = undefined;
          this.#retainSearchPanelFocus = false;
        } else if (e.key === 'Enter') {
          e.preventDefault();
          searchParams.action = 'findNext';
          const match = this.#search(searchParams, true);
          this.#updateSearchMatches(allMatches, searchParams.text, match);
        } else if (e.key === 'f' && isPrimaryModifier(e)) {
          // prevent the default browser search panel open behavior
          e.preventDefault();
        }
      },
    });
    const matchesElement = h('div', {
      dataset: 'matches',
    });
    const searchPanel = h('div', {
      dataset: 'searchPanel',
      children: [
        h('div', {
          dataset: 'searchPanelRow',
          children: [
            h('div', {
              dataset: { icon: 'search' },
              innerHTML: `<svg width="16" height="16" viewBox="0 0 20 20">
                <line x1="16.5" y1="16.5" x2="12.0355" y2="12.0355" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></line>
                <circle cx="8.5" cy="8.5" r="5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></circle>
                </svg>
              `,
            }),
            inputElement,
            matchesElement,
            h('div', {
              dataset: { icon: 'arrow-up', disabled: 'false' },
              title: 'Previous',
              innerHTML: `<svg width="16" height="16" viewBox="0 0 20 20">
                <line x1="10" y1="17" x2="10" y2="3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></line>
                <polyline points="15 8 10 3 5 8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></polyline>
                </svg>
              `,
              onclick: () => {
                searchParams.action = 'findPrevious';
                const match = this.#search(searchParams);
                this.#updateSearchMatches(allMatches, searchParams.text, match);
              },
            }),
            h('div', {
              dataset: { icon: 'arrow-down', disabled: 'false' },
              title: 'Next',
              innerHTML: `<svg width="16" height="16" viewBox="0 0 20 20">
                  <line x1="10" y1="3" x2="10" y2="17" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></line>
                  <polyline points="5 12 10 17 15 12" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></polyline>
                  </svg>
                `,
              onclick: () => {
                searchParams.action = 'findNext';
                const match = this.#search(searchParams);
                this.#updateSearchMatches(allMatches, searchParams.text, match);
              },
            }),
            h('div', {
              dataset: 'spacer',
            }),
            h('div', {
              dataset: { icon: 'close' },
              title: 'Close',
              innerHTML: `<svg width="16" height="16" viewBox="0 0 20 20">
                <line x1="5" y1="5" x2="15" y2="15" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></line>
                <line x1="5" y1="15" x2="15" y2="5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></line>
                </svg>
              `,
              onclick: () => {
                this.#searchPanelElement?.remove();
                this.#searchPanelElement = undefined;
                this.#retainSearchPanelFocus = false;
              },
            }),
          ],
        }),
      ],
    });
    preElement.before(searchPanel);
    this.#searchPanelElement = searchPanel;
    this.#retainSearchPanelFocus = false;
    requestAnimationFrame(() => {
      if (defaultQuery !== '') {
        updateAllMatches();
        const startOffset = textDocument.offsetAt(primarySelection.start);
        const endOffset = textDocument.offsetAt(primarySelection.end);
        this.#updateSearchMatches(allMatches, searchParams.text, [
          startOffset,
          endOffset,
        ]);
      }
      inputElement.select();
    });
  }

  #search(
    searchParams: DiffsEditorSearchParams,
    retainSearchPanelFocus: boolean = false
  ): [number, number] | undefined {
    const primarySelection = this.#selections?.at(-1);
    const textDocument = this.#textDocument;
    if (textDocument === undefined) {
      return undefined;
    }
    const matches = textDocument.search(searchParams, primarySelection);
    if (matches.length === 0) {
      return undefined;
    }

    const [startOffset, endOffset] = matches[0];
    const startPosition = textDocument.positionAt(startOffset);
    const action = searchParams.action;

    if (
      action === 'findNext' ||
      action === 'findPrevious' ||
      action === 'replace'
    ) {
      const nextSelection = createSelectionFromAnchorAndFocusOffsets(
        textDocument,
        startOffset,
        endOffset
      );
      this.#updateSelections([nextSelection], true);
      this.#scrollToPrimaryCaret();
      if (retainSearchPanelFocus) {
        this.#retainSearchPanelFocus = true;
        requestAnimationFrame(() => {
          this.#focusSearchPanelInput();
        });
      }
      return [startOffset, endOffset];
    } else if (action === 'findAll' || action === 'replaceAll') {
      this.#scrollToLine(startPosition.line);
    }
    return undefined;
  }

  #updateSearchMatches(
    allMatches: [number, number][],
    searchText: string,
    currentMatch: [number, number] = allMatches[0]
  ) {
    const matchesElement =
      this.#searchPanelElement?.querySelector<HTMLElement>('[data-matches]');
    if (matchesElement == null) return;

    if (searchText === '') {
      matchesElement.textContent = '';
      delete matchesElement.dataset.noMatches;
      return;
    }

    if (allMatches.length === 0) {
      matchesElement.textContent = 'No results';
      matchesElement.dataset.noMatches = '';
    } else {
      delete matchesElement.dataset.noMatches;
      const index = allMatches.findIndex(
        (m) => m[0] === currentMatch[0] && m[1] === currentMatch[1]
      );
      matchesElement.textContent =
        index !== -1 ? `${index + 1} of ${allMatches.length}` : 'No results';
    }
  }

  #focusSearchPanelInput() {
    const rowElements = this.#searchPanelElement?.firstElementChild?.children;
    if (rowElements === undefined) {
      return;
    }
    for (const rowElement of rowElements) {
      if (rowElement instanceof HTMLInputElement) {
        rowElement.select();
        break;
      }
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
    this.#lastCharX = undefined;

    this.#selections = selections;
    this.#rerender(change, lineAnnotations);

    if (selections !== undefined) {
      // since we prevent the default input event,
      // we need to update the window selection manually
      // and scroll to the primary caret to mock the input behavior
      this.#updateSelections(selections, true);
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
    const gutterElement =
      this.#contentElement?.previousElementSibling ?? undefined;
    if (
      gutterElement instanceof HTMLElement &&
      gutterElement.hasAttribute('data-gutter')
    ) {
      // Prefer the live gutter width: `--diffs-column-number-width` is updated
      // asynchronously by ResizeManager and can lag after line-count edits.
      const measuredWidth = gutterElement.offsetWidth;
      if (measuredWidth > 0) {
        return measuredWidth;
      }
    }

    const diffsColumnNumberWidth =
      this.#contentElement?.parentElement?.style.getPropertyValue(
        '--diffs-column-number-width'
      ) ?? '';
    if (
      diffsColumnNumberWidth.length > 2 &&
      diffsColumnNumberWidth.endsWith('px')
    ) {
      return Number(diffsColumnNumberWidth.slice(0, -2));
    }
    return 0;
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

    const div = h(
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
