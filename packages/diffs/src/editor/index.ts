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
import type { FileContents } from '../types';
import { EDITOR_CSS } from './constants';

export class Editor<T> {
  #file?: File<T>;
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
  #textareSelectionStart = 0;
  #shouldIgnoreSelectionChange = false;
  #textareaBuffer?: { text: string; line: number };
  #textareaBufferFlushTimeout?: ReturnType<typeof setTimeout>;
  #textareaSnapshot?: TextareaSnapshot;
  #selections?: EditorSelection[];
  #reservedSelections?: EditorSelection[];

  #disposes?: (() => void)[];

  get text(): string | undefined {
    return this.#textDocument?.getText();
  }

  edit(file: File<T>, onChange?: (file: FileContents) => void): () => void {
    file.__onEditable((fileContents, fileContainer) => {
      this.#onEditable(fileContents, fileContainer);
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
    this.#textareaBuffer = undefined;
    this.#textareaBufferFlushTimeout = undefined;
    this.#textareaSnapshot = undefined;
    this.#selections = undefined;
    this.#reservedSelections = undefined;
  }

  #onEditable(fileContents: FileContents, fileContainer: HTMLElement): void {
    this.#fileContents ??= fileContents;
    this.#textDocument ??= new TextDocument(
      fileContents.name,
      fileContents.contents,
      fileContents.lang
    );

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
          const { selectionStart } = this.#textareaEl;
          console.log(selectionStart, this.#textareSelectionStart);
          if (
            this.#textareSelectionStart !== selectionStart &&
            this.#textareaSnapshot.text === this.#textareaEl.value
          ) {
            console.log('\n~~~~~~~~~', Math.round(Date.now() / 1000));
            console.log('textarea: selectionchange');
            this.#textareSelectionStart = selectionStart;
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
          console.log('\n~~~~~~~~~', Math.round(Date.now() / 1000));
          console.log('document: selectionchange', selection);
          const reservedSelections = this.#reservedSelections;
          if (reservedSelections !== undefined) {
            this.#restoreSelections([
              ...reservedSelections.filter(
                (reservedSelection) =>
                  !selectionIntersects(reservedSelection, selection)
              ),
              selection,
            ]);
          } else {
            this.#restoreSelections([selection]);
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
          this.#flushPendingTextareaChanges();
          e.preventDefault();
          void this.#runCommand(command);
        }
      }),

      addEventListener(this.#textareaEl, 'input', () => {
        console.log('input');
        if (this.#shouldIgnoreSelectionChange) {
          return;
        }
        console.log('\n~~~~~~~~~', Math.round(Date.now() / 1000));
        console.log('textarea: input');
        this.#syncTextareaState();
      }),
    ];
    if (this.#selections !== undefined) {
      this.#restoreSelections(this.#selections);
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
    const newFile: FileContents = {
      ...this.#fileContents,
      contents: textDocument.getText(),
    };
    this.#file.__rerender(newFile);
    this.#onChange?.(newFile);
    if (nextSelections !== undefined) {
      this.#restoreSelections(nextSelections);
    }
  }

  #renderLine(line: string, offset: number) {
    console.log({ line, offset });
  }

  #syncTextareaState() {
    console.log('syncTextareaState');
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
      if (
        value.split('\n').length !== textareaSnapshot.lines ||
        textareaSnapshot.lines !== 3
      ) {
        const change = resolveTextChange(textareaSnapshot, value);
        this.#applyTextChange(change);
      } else {
        const line = value.split('\n')[1];
        this.#renderLine(line, textareaSnapshot.offset + selectionStart);
        this.#textareaBuffer = {
          text: value,
          line: textareaSnapshot.startLine,
        };
        this.#textareaBufferFlushTimeout = setTimeout(() => {
          this.#textareaBufferFlushTimeout = undefined;
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
          textDocument.positionAt(textareaSnapshot.offset + selectionStart)
        )
      );
    }
  }

  #flushPendingTextareaChanges() {
    if (this.#textareaBufferFlushTimeout !== undefined) {
      window.clearTimeout(this.#textareaBufferFlushTimeout);
      this.#textareaBufferFlushTimeout = undefined;
    }
    if (
      this.#textareaSnapshot !== undefined &&
      this.#textareaBuffer !== undefined
    ) {
      const change = resolveTextChange(
        this.#textareaSnapshot,
        this.#textareaBuffer.text
      );
      this.#textareaBuffer = undefined;
      this.#applyTextChange(change);
    }
  }

  #applyTextChange(change: EditorTextChange) {
    console.log('applyTextChange', change);
    if (this.#textDocument !== undefined && this.#selections !== undefined) {
      const newSelections = applySelectionTextChange(
        this.#textDocument,
        this.#selections,
        change
      );
      this.#rerender(this.#textDocument, newSelections);
    }
  }

  #restoreSelections(selections: EditorSelection[]) {
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
      this.#renderCaret(selection, selectionEls);
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
    const textareaSnapshot = createTextareaSnapshot(
      textDocument,
      primarySelection
    );
    this.#shouldIgnoreSelectionChange = true;
    this.#textareSelectionStart = textareaSnapshot.selectionStart;
    this.#textareaSnapshot = textareaSnapshot;
    textareaEl.style.top = this.#getLineY(primarySelection.start.line) + 'px';
    textareaEl.style.height = textareaSnapshot.lines + 'lh';
    textareaEl.value = textareaSnapshot.text;
    textareaEl.setSelectionRange(
      textareaSnapshot.selectionStart,
      textareaSnapshot.selectionEnd
    );
    setTimeout(() => {
      console.log('^');
      this.#shouldIgnoreSelectionChange = false;
    }, 0);
  }

  #renderLineHighlight(
    selection: EditorSelection,
    cacheMap: Map<string, HTMLElement>
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
    cacheMap.set(`lineHighlight-${selection.start.line}`, hlEl);
  }

  #renderSelectionRange(
    selection: EditorSelection,
    ch: number,
    cacheMap: Map<string, HTMLElement>
  ) {
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
      let left = 0;
      let width = 0;
      if (startChar === endChar && startChar === 0) {
        left = ch;
      } else {
        const startX = this.#getCharacterX(ln, startChar);
        const endX =
          endChar === startChar ? startX : this.#getCharacterX(ln, endChar);
        left = startX;
        width = endX - startX;
      }
      const spacing = ln === end.line ? 0 : ch;
      const style = {
        top: this.#getLineY(ln) + 'px',
        left: left + 'px',
        width: width + spacing + 'px',
      };
      const selectionEl = createElement(
        'div',
        { dataset: 'selectionRange', style },
        this.#contentEl
      );
      cacheMap.set(`selection-${ln}-${startChar}-${endChar}`, selectionEl);
    }
  }

  #renderCaret(selection: EditorSelection, cacheMap: Map<string, HTMLElement>) {
    const { start, end, direction } = selection;
    const isBackward = direction === SelectionDirection.Backward;
    const line = isBackward ? start.line : end.line;
    const character = isBackward ? start.character : end.character;
    const left = this.#getCharacterX(line, character);
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
    cacheMap.set('caret-' + line + '-' + character + '-' + direction, caretEl);
  }

  async #runCommand(command: EditorCommand) {
    switch (command) {
      case 'selectAll':
        this.#restoreSelections([this.#getFullSelection()]);
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
        this.#restoreSelections([
          this.#getDocumentBoundarySelection(command === 'documentEnd'),
        ]);
        break;

      case 'undo':
        if (this.#textDocument?.canUndo === true) {
          this.#rerender(this.#textDocument, this.#textDocument.undo());
        }
        break;

      case 'redo':
        if (this.#textDocument?.canRedo === true) {
          this.#rerender(this.#textDocument, this.#textDocument.redo());
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

export function edit<T>(file: File<T>): void {
  const editor = new Editor<T>();
  editor.edit(file);
}
