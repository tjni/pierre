import { areThemesAttached, DEFAULT_THEMES, getHighlighterIfLoaded } from '..';
import type { File } from '../components/File';
import {
  type EditorCommand,
  isPrimaryModifier,
  resolveEditorCommandFromKeyboardEvent,
} from '../editor/editorCommand';
import {
  applySelectionTextChange,
  applySelectionTextReplace,
  mapSelectionMove,
  mapSelectionRangeMove,
} from '../editor/editorMultiSelections';
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
} from '../editor/editorSelection';
import {
  createTextareaSnapshot,
  resolveTextChange,
  type TextareaSnapshot,
} from '../editor/editorTextareaSnapshot';
import {
  addEventListener,
  createElement,
  extend,
  getLineIndentationUnit,
  isCodeLineTarget,
} from '../editor/editorUtils';
import { TextDocument, type TextEdit } from '../editor/textDocument';
import type { FileContents, RenderRange } from '../types';
import { renderFileWithHighlighter } from '../utils/renderFileWithHighlighter';
import { EDITOR_CSS } from './constants';

export class Editor<LAnnotation> {
  #file?: File<LAnnotation>;
  #renderRange?: RenderRange;
  #fileContents?: FileContents;
  #textDocument?: TextDocument;
  #onChange?: (file: FileContents) => void;

  // dom elements
  #contentEl?: HTMLElement;
  #styleEl?: HTMLStyleElement;
  #textareaEl?: HTMLTextAreaElement;
  #selectionEls?: Map<string, HTMLElement>;

  // state
  #selectionLineHeight = 20;
  #selectionStartX = 0;
  #selectionStartY = 0;
  #selectionEndX = 0;
  #selectionEndY = 0;
  #textareaSelectionStart = 0;
  #textareaSelectionEnd = 0;
  #textareaSelectionDirection: HTMLTextAreaElement['selectionDirection'] =
    'none';
  #shouldIgnoreSelectionChange = false;
  #textareaSnapshot?: TextareaSnapshot;
  #selections?: EditorSelection[];
  #reservedSelections?: EditorSelection[];

  #disposes?: (() => void)[];

  get text(): string | undefined {
    return this.#textDocument?.getText();
  }

  edit(
    file: File<LAnnotation>,
    onChange?: (file: FileContents) => void
  ): () => void {
    file.__addEditorHook((fileContainer, fileContents) => {
      this.#initialize(fileContainer, fileContents);
    });
    this.#file = file;
    this.#onChange = onChange;
    return this.cleanUp.bind(this);
  }

  cleanUp(): void {
    this.#disposes?.forEach((dispose) => dispose());
    this.#disposes = undefined;
    this.#textDocument = undefined;

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

  #initialize(fileContainer: HTMLElement, fileContents: FileContents): void {
    console.log('[editor] initialize');

    if (
      this.#fileContents === undefined ||
      this.#fileContents.contents !== fileContents.contents
    ) {
      this.#fileContents = fileContents;
      this.#textDocument = new TextDocument(
        fileContents.name,
        fileContents.contents,
        fileContents.lang
      );
    }

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
        if (
          this.#textareaEl !== undefined &&
          this.#textareaSnapshot !== undefined
        ) {
          const { selectionStart, selectionEnd, selectionDirection } =
            this.#textareaEl;
          if (
            (this.#textareaSelectionStart !== selectionStart ||
              this.#textareaSelectionEnd !== selectionEnd ||
              this.#textareaSelectionDirection !== selectionDirection) &&
            this.#textareaSnapshot.text === this.#textareaEl.value
          ) {
            this.#textareaSelectionStart = selectionStart;
            this.#textareaSelectionEnd = selectionEnd;
            this.#textareaSelectionDirection = selectionDirection;
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
          const reservedSelections = this.#reservedSelections;
          if (reservedSelections !== undefined) {
            this.#setSelections([
              ...reservedSelections.filter(
                (reservedSelection) =>
                  !selectionIntersects(reservedSelection, selection)
              ),
              selection,
            ]);
          } else {
            this.#setSelections([selection]);
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

        this.#selectionLineHeight = this.#getLineHeight();
        this.#selectionStartY = e.clientY;
        this.#selectionStartX = e.clientX;
        this.#selectionEndX = e.clientX;
        this.#selectionEndY = e.clientY;
      }),

      addEventListener(document, 'mouseup', (e) => {
        if (!isCodeLineTarget(e.composedPath()[0])) {
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
    if (this.#selections !== undefined) {
      this.#setSelections(this.#selections);
      this.#textareaEl.focus();
    }
  }

  #computeMouseSelectionDirection(): SelectionDirection {
    const startLine = Math.ceil(
      this.#selectionStartY / this.#selectionLineHeight
    );
    const endLine = Math.ceil(this.#selectionEndY / this.#selectionLineHeight);
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
    if (this.#fileContents === undefined || this.#file === undefined) {
      return;
    }

    this.#fileContents.contents = textDocument.getText();
    this.#onChange?.({ ...this.#fileContents });

    const highlighter = areThemesAttached(
      this.#file.options.theme ?? DEFAULT_THEMES
    )
      ? getHighlighterIfLoaded()
      : undefined;
    if (highlighter !== undefined) {
      let t = performance.now();
      const { theme = DEFAULT_THEMES, tokenizeMaxLineLength = 1000 } =
        this.#file.options;
      const { startingLine = 0, totalLines = textDocument.lineCount } =
        this.#renderRange ?? {};
      const text = textDocument.getText({
        start: { line: startingLine, character: 0 },
        end: { line: startingLine + totalLines, character: 0 },
      });
      const result = renderFileWithHighlighter(
        { ...this.#fileContents, contents: text },
        highlighter,
        {
          theme,
          tokenizeMaxLineLength,
          useTokenTransformer: true, // get `data-char` on token span
        }
      );
      console.log(
        '[editor] renderFileWithHighlighter time:',
        performance.now() - t
      );

      const lineElMap = new Map<number, HTMLDivElement>();
      for (const child of this.#contentEl?.children ?? []) {
        const divEl = child as HTMLDivElement;
        if (divEl.dataset.lineIndex === undefined) {
          continue;
        }
        lineElMap.set(Number(divEl.dataset.lineIndex), divEl);
      }

      for (const line of result.code) {
        if (line.type === 'element') {
          const lineIndex = line.properties['data-line-index'];
          if (typeof lineIndex === 'number') {
            const oldLineEl = lineElMap.get(lineIndex);
            if (oldLineEl !== undefined) {
              const newLineEl = createElement(
                line.tagName as keyof HTMLElementTagNameMap,
                {
                  dataset: {
                    line: String(lineIndex + 1),
                    lineIndex: String(lineIndex),
                    lineType: String(line.properties['data-line-type']),
                  },
                }
              );
              for (const span of line.children) {
                if (span.type === 'element') {
                  const token = span.children[0];
                  createElement(
                    span.tagName as keyof HTMLElementTagNameMap,
                    {
                      dataset: {
                        char: String(span.properties['data-char']),
                      },
                      style: {
                        cssText: span.properties['style'] as string | undefined,
                      },
                      textContent:
                        token.type === 'text' ? token.value : undefined,
                    },
                    newLineEl
                  );
                }
              }
              oldLineEl.replaceWith(newLineEl);
            }
          }
        }
      }

      if (nextSelections !== undefined) {
        this.#setSelections(nextSelections);
      }
    }
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
      const change = resolveTextChange(textareaSnapshot, value);
      this.#applyTextChange(change);
    } else if (this.#selections !== undefined) {
      // Selection in the textarea changed, but no text change was made.
      if (selectionStart === selectionEnd) {
        this.#setSelections(
          mapSelectionMove(
            textDocument,
            this.#selections,
            textDocument.positionAt(textareaSnapshot.offset + selectionStart)
          )
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
        this.#setSelections(
          mapSelectionRangeMove(
            textDocument,
            this.#selections,
            textDocument.positionAt(anchorOffset),
            textDocument.positionAt(focusOffset)
          )
        );
      }
    }
  }

  #applyTextChange(change: EditorTextChange) {
    if (this.#textDocument !== undefined && this.#selections !== undefined) {
      const newSelections = applySelectionTextChange(
        this.#textDocument,
        this.#selections,
        change
      );
      this.#rerender(this.#textDocument, newSelections);
    }
  }

  #setSelections(selections: EditorSelection[]) {
    const primarySelection = getPrimarySelection(selections);
    if (primarySelection === undefined) {
      return;
    }
    this.#selections = selections;
    this.#file?.setSelectedLines(null);
    const selectionEls = new Map<string, HTMLElement>();
    if (isCollapsedSelection(primarySelection)) {
      this.#renderLineHighlight(primarySelection, selectionEls);
    }
    const ch = this.#chToPx();
    selections.forEach((selection) => {
      if (selections.length > 1 || !isCollapsedSelection(selection)) {
        this.#renderSelectionRange(selection, ch, selectionEls);
      }
      this.#renderCaret(selection, ch, selectionEls);
    });
    this.#selectionEls?.forEach((el) => el.remove());
    this.#selectionEls?.clear();
    this.#selectionEls = selectionEls;
    this.#updateTextarea(primarySelection);
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
    const textareaSelectionDirection =
      getTextareaSelectionDirection(primarySelection);
    this.#textareaSelectionStart = textareaSnapshot.selectionStart;
    this.#textareaSelectionEnd = textareaSnapshot.selectionEnd;
    this.#textareaSelectionDirection = textareaSelectionDirection;
    this.#textareaSnapshot = textareaSnapshot;
    this.#shouldIgnoreSelectionChange = true;
    textareaEl.style.top = this.#getLineY(primarySelection.start.line) + 'px';
    textareaEl.style.height = textareaSnapshot.lines + 'lh';
    textareaEl.value = textareaSnapshot.text;
    textareaEl.setSelectionRange(
      textareaSnapshot.selectionStart,
      textareaSnapshot.selectionEnd,
      textareaSelectionDirection
    );
    setTimeout(() => {
      this.#shouldIgnoreSelectionChange = false;
    }, 0);
  }

  #renderLineHighlight(
    selection: EditorSelection,
    markMap: Map<string, HTMLElement>
  ) {
    const hlEl = createElement(
      'div',
      {
        dataset: 'lineHighlight',
        style: {
          top: this.#getLineY(selection.start.line) + 'px',
        },
      },
      this.#contentEl
    );
    this.#file?.setSelectedLines({
      start: selection.start.line + 1,
      end: selection.end.line + 1,
    });
    // hlEl.scrollIntoView({ block: "nearest" });
    markMap.set(`lineHighlight-${selection.start.line}`, hlEl);
  }

  #renderSelectionRange(
    selection: EditorSelection,
    ch: number,
    markMap: Map<string, HTMLElement>
  ) {
    const selectionEls = this.#selectionEls;
    const { start, end } = selection;

    for (let ln = start.line; ln <= end.line; ln++) {
      const lineText = this.#textDocument?.getLineText(ln);
      if (lineText === undefined) {
        // ignore out of bounds line
        continue;
      }

      const lineLength = lineText.length;
      const startChar = ln === start.line ? start.character : 0;
      const endChar = ln === end.line ? end.character : lineLength;
      const spacing = ln === end.line ? 0 : ch;
      const cacheKey = `selection-${ln}-${startChar}-${endChar}`;

      let left = 0;
      let width = spacing;
      let rangeEl: HTMLElement | undefined;

      if (selectionEls?.has(cacheKey) === true) {
        console.log('use cached selection range', cacheKey);
        rangeEl = selectionEls.get(cacheKey)!;
        selectionEls.delete(cacheKey);
      } else {
        if (startChar === endChar && startChar === 0) {
          left = ch;
        } else {
          const startX = this.#getCharacterX(ln, startChar);
          const endX =
            endChar === startChar ? startX : this.#getCharacterX(ln, endChar);
          left = startX;
          width = endX - startX;
        }

        for (const [key, el] of selectionEls?.entries() ?? []) {
          if (key.startsWith(`selection-${ln}-`)) {
            rangeEl = el;
            selectionEls?.delete(key);
            el.style.left = left + 'px';
            el.style.width = width + 'px';
            break;
          }
        }

        rangeEl ??= createElement('div', {
          dataset: 'selectionRange',
          style: {
            top: this.#getLineY(ln) + 'px',
            left: left + 'px',
            width: width + 'px',
          },
        });
      }

      this.#contentEl?.append(rangeEl);
      markMap.set(cacheKey, rangeEl);
    }
  }

  #renderCaret(
    selection: EditorSelection,
    ch: number,
    markMap: Map<string, HTMLElement>
  ) {
    const { start, end, direction } = selection;
    const isBackward = direction === SelectionDirection.Backward;
    const line = isBackward ? start.line : end.line;
    const character = isBackward ? start.character : end.character;
    const left = Math.max(ch, this.#getCharacterX(line, character));
    const caretEl = createElement(
      'div',
      {
        dataset: 'caret',
        style: {
          top: this.#getLineY(line) + 'px',
          left: left + 'px',
        },
      },
      this.#contentEl
    );
    markMap.set('caret-' + line + '-' + character + '-' + direction, caretEl);
  }

  async #runCommand(command: EditorCommand) {
    switch (command) {
      case 'selectAll':
        this.#setSelections([this.#getFullSelection()]);
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
          const tabSize = this.#getTabSize();
          for (const selection of this.#selections) {
            const startLine = selection.start.line;
            const lineText = this.#textDocument.getLineText(startLine);
            if (lineText !== undefined) {
              const outdent = command === 'outdent';
              if (startLine !== selection.end.line || outdent) {
                const ret = resolveIndentEdits(
                  this.#textDocument,
                  selection,
                  tabSize,
                  outdent
                );
                edits.push(...ret[0]);
                nextSelections.push(ret[1]);
              } else {
                const indentUnit = getLineIndentationUnit(lineText, tabSize);
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
            this.#rerender(this.#textDocument, nextSelections);
          }
        }
        break;

      case 'documentStart':
      case 'documentEnd':
        this.#setSelections([
          this.#getDocumentBoundarySelection(command === 'documentEnd'),
        ]);
        break;

      case 'undo':
        if (this.#textDocument?.canUndo === true) {
          const undoSelections = this.#textDocument.undo();
          this.#rerender(this.#textDocument, undoSelections);
        }
        break;

      case 'redo':
        if (this.#textDocument?.canRedo === true) {
          const redoSelections = this.#textDocument.redo();
          this.#rerender(this.#textDocument, redoSelections);
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
    const nextSelections = Array.isArray(normalizedText)
      ? applySelectionTextReplace(textDocument, selections, normalizedText)
      : applySelectionTextChange(textDocument, selections, {
          start: textDocument.offsetAt(selection.start),
          end: textDocument.offsetAt(selection.end),
          text: normalizedText,
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

  #getTabSize(): number {
    const tabSize = this.#contentEl?.computedStyleMap().get('tab-size');
    if (
      tabSize !== undefined &&
      tabSize instanceof CSSUnitValue &&
      tabSize.unit === 'number'
    ) {
      return tabSize.value;
    }
    return 2;
  }

  #getLineHeight(): number {
    const lineHeight = this.#contentEl?.computedStyleMap().get('line-height');
    if (
      lineHeight !== undefined &&
      lineHeight instanceof CSSUnitValue &&
      lineHeight.unit === 'px'
    ) {
      return Number(lineHeight.value);
    }
    return 20;
  }

  #chToPx(): number {
    if (this.#contentEl !== undefined) {
      const el = document.createElement('div');
      el.style.width = '1ch';
      el.style.position = 'absolute';
      el.style.visibility = 'hidden';
      this.#contentEl.appendChild(el);
      const px = el.offsetWidth;
      el.remove();
      return px;
    }
    return 0;
  }

  // get line Y position
  #getLineY(line: number) {
    return this.#getLineElement(line)?.offsetTop ?? 0;
  }

  // get character X position
  #getCharacterX(line: number, character: number) {
    const contentEl = this.#contentEl;
    const lineEl = this.#getLineElement(line);
    if (
      contentEl === undefined ||
      lineEl === undefined ||
      !lineEl.hasChildNodes()
    ) {
      return 0;
    }

    const children = lineEl.children;
    if (children.length === 1 && children[0] instanceof Text) {
      return 0;
    }

    let targetSpan: HTMLElement | undefined;
    let targetOffset = 0;
    let lastSpan: HTMLElement | undefined;
    let lastEnd = 0;
    for (const child of children) {
      if (!(child instanceof HTMLElement) || child.tagName !== 'SPAN') {
        continue;
      }
      const dataChar = child.dataset.char;
      if (dataChar === undefined) {
        continue;
      }
      const start = Number(dataChar);
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
        return 0;
      }
      const nodeLength = textNode.textContent?.length ?? 0;
      const boundedOffset = Math.max(0, Math.min(targetOffset, nodeLength));
      range.setStart(textNode, boundedOffset);
      range.setEnd(textNode, boundedOffset);
    } else if (lastSpan !== undefined) {
      const textNode = lastSpan.firstChild;
      if (textNode === null) {
        return 0;
      }
      const nodeLength = textNode.textContent?.length ?? 0;
      range.setStart(textNode, nodeLength);
      range.setEnd(textNode, nodeLength);
    } else {
      return 0;
    }

    const editorRect = contentEl.getBoundingClientRect();
    const pointRect = range.getBoundingClientRect();
    return pointRect.left - editorRect.left;
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

function getSelectionDirectionFromTextarea(
  textareaEl: HTMLTextAreaElement
): SelectionDirection {
  return textareaEl.selectionDirection === 'backward'
    ? SelectionDirection.Backward
    : SelectionDirection.Forward;
}

function getTextareaSelectionDirection(
  selection: EditorSelection
): HTMLTextAreaElement['selectionDirection'] {
  switch (selection.direction) {
    case SelectionDirection.Backward:
      return 'backward';
    case SelectionDirection.Forward:
      return 'forward';
    case SelectionDirection.None:
      return 'none';
  }
}

export function edit<T>(file: File<T>): void {
  const editor = new Editor<T>();
  editor.edit(file);
}
