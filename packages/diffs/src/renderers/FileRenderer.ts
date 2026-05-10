import type { ElementContent, Element as HASTElement } from 'hast';
import { toHtml } from 'hast-util-to-html';

import { DEFAULT_RENDER_RANGE, DEFAULT_THEMES } from '../constants';
import { areLanguagesAttached } from '../highlighter/languages/areLanguagesAttached';
import {
  getHighlighterIfLoaded,
  getSharedHighlighter,
} from '../highlighter/shared_highlighter';
import { areThemesAttached } from '../highlighter/themes/areThemesAttached';
import { hasResolvedThemes } from '../highlighter/themes/hasResolvedThemes';
import type {
  BaseCodeOptions,
  DiffsHighlighter,
  FileContents,
  FileHeaderRenderMode,
  HighlightedToken,
  LineAnnotation,
  RenderedFileASTCache,
  RenderFileOptions,
  RenderFileResult,
  RenderRange,
  SupportedLanguages,
  ThemedFileResult,
} from '../types';
import { areRenderRangesEqual } from '../utils/areRenderRangesEqual';
import { areThemesEqual } from '../utils/areThemesEqual';
import { computeLineOffsets } from '../utils/computeFileOffsets';
import { createAnnotationElement } from '../utils/createAnnotationElement';
import { createContentColumn } from '../utils/createContentColumn';
import { createFileHeaderElement } from '../utils/createFileHeaderElement';
import { createPreElement } from '../utils/createPreElement';
import { getFiletypeFromFileName } from '../utils/getFiletypeFromFileName';
import { getHighlighterOptions } from '../utils/getHighlighterOptions';
import { getLineAnnotationName } from '../utils/getLineAnnotationName';
import { getThemes } from '../utils/getThemes';
import {
  createGutterGap,
  createGutterItem,
  createGutterWrapper,
  createHastElement,
} from '../utils/hast_utils';
import { isFilePlainText } from '../utils/isFilePlainText';
import { renderFileWithHighlighter } from '../utils/renderFileWithHighlighter';
import { shouldUseTokenTransformer } from '../utils/shouldUseTokenTransformer';
import type { WorkerPoolManager } from '../worker';

type AnnotationLineMap<LAnnotation> = Record<
  number,
  LineAnnotation<LAnnotation>[] | undefined
>;

interface GetRenderOptionsReturn {
  options: RenderFileOptions;
  forceRender: boolean;
}

export interface FileRenderResult {
  gutterAST: ElementContent[];
  contentAST: ElementContent[];
  preAST: HASTElement;
  headerAST: HASTElement | undefined;
  css: string;
  totalLines: number;
  themeStyles: string;
  baseThemeType: 'light' | 'dark' | undefined;
  rowCount: number;
  bufferBefore: number;
  bufferAfter: number;
}

export interface FileRendererOptions extends BaseCodeOptions {
  headerRenderMode?: FileHeaderRenderMode;
}

let instanceId = -1;

export class FileRenderer<LAnnotation = undefined> {
  readonly __id: string = `file-renderer:${++instanceId}`;

  private highlighter: DiffsHighlighter | undefined;
  private renderCache: RenderedFileASTCache | undefined;
  private computedLang: SupportedLanguages = 'text';
  private lineAnnotations: AnnotationLineMap<LAnnotation> = {};
  private lineOffsets = new WeakMap<FileContents, number[]>();
  private alternateLineCount = new WeakMap<FileContents, number>();

  constructor(
    public options: FileRendererOptions = { theme: DEFAULT_THEMES },
    private onRenderUpdate?: () => unknown,
    private workerManager?: WorkerPoolManager | undefined
  ) {
    if (workerManager?.isWorkingPool() !== true) {
      this.highlighter = areThemesAttached(options.theme ?? DEFAULT_THEMES)
        ? getHighlighterIfLoaded()
        : undefined;
    }
  }

  public setOptions(options: FileRendererOptions): void {
    this.options = options;
  }

  public mergeOptions(options: Partial<FileRendererOptions>): void {
    this.options = { ...this.options, ...options };
  }

  public setLineAnnotations(
    lineAnnotations: LineAnnotation<LAnnotation>[]
  ): void {
    this.lineAnnotations = {};
    for (const annotation of lineAnnotations) {
      const arr = this.lineAnnotations[annotation.lineNumber] ?? [];
      this.lineAnnotations[annotation.lineNumber] = arr;
      arr.push(annotation);
    }
  }

  public cleanUp(): void {
    this.renderCache = undefined;
    this.highlighter = undefined;
    this.workerManager = undefined;
    this.onRenderUpdate = undefined;
  }

  public hydrate(file: FileContents): void {
    const { options } = this.getRenderOptions(file);
    let cache = this.workerManager?.getFileResultCache(file);
    if (cache != null && !areRenderOptionsEqual(options, cache.options)) {
      cache = undefined;
    }
    this.renderCache ??= {
      file,
      options,
      highlighted: !isFilePlainText(file),
      result: cache?.result,
      // FIXME(amadeus): Add support for renderRanges
      renderRange: undefined,
    };
    if (this.workerManager?.isWorkingPool() === true) {
      if (this.renderCache.result == null) {
        // We should only kick off a preload of the AST if we have a WorkerPool
        this.workerManager.highlightFileAST(this, file);
      }
    }
    // Lets attempt to get the highlighter/languages ready immediately
    else if (this.highlighter == null) {
      this.computedLang = file.lang ?? getFiletypeFromFileName(file.name);
      void this.initializeHighlighter();
    }
  }

  private getRenderOptions(file: FileContents): GetRenderOptionsReturn {
    const options: RenderFileOptions = (() => {
      if (this.workerManager?.isWorkingPool() === true) {
        return this.workerManager.getFileRenderOptions();
      }
      const { theme = DEFAULT_THEMES, tokenizeMaxLineLength = 1000 } =
        this.options;
      return {
        theme,
        useTokenTransformer: shouldUseTokenTransformer(this.options),
        tokenizeMaxLineLength,
      };
    })();
    const { renderCache } = this;
    if (renderCache?.result == null) {
      return { options, forceRender: true };
    }
    if (
      file !== renderCache.file ||
      !areRenderOptionsEqual(options, renderCache.options)
    ) {
      return { options, forceRender: true };
    }
    return { options, forceRender: false };
  }

  public getOrCreateLineOffsets(file: FileContents): number[] {
    let offsets = this.lineOffsets.get(file);
    if (offsets == null) {
      offsets = computeLineOffsets(file.contents);
      this.lineOffsets.set(file, offsets);
    }
    return offsets;
  }

  public getLineCount(file: FileContents): number {
    return (
      this.alternateLineCount.get(file) ??
      this.getOrCreateLineOffsets(file).length
    );
  }

  public emitDirtyLines(
    dirtyLines: Map<number, Array<HighlightedToken>>
  ): void {
    const renderCache = this.renderCache;
    if (renderCache == null || renderCache.result == null) {
      return;
    }
    for (const [line, tokens] of dirtyLines) {
      renderCache.result.code[line] = {
        type: 'element',
        tagName: 'div',
        properties: {
          'data-line': line + 1,
          'data-line-type': 'context',
          'data-line-index': line,
        },
        children: tokens.map(([char, style, text]) => {
          if (char === 0 && style === '') {
            return {
              type: 'text',
              value: text,
            };
          }
          return {
            type: 'element',
            tagName: 'span',
            properties: {
              'data-char': char,
              style,
            },
            children: [
              {
                type: 'text',
                value: text,
              },
            ],
          };
        }),
      };
    }
  }

  public emitLineCountChange(
    lineCount: number,
    newLineAnnotations?: LineAnnotation<LAnnotation>[],
    renderRange: RenderRange = DEFAULT_RENDER_RANGE
  ): FileRenderResult | undefined {
    const renderCache = this.renderCache;
    if (renderCache == null || renderCache.result == null) {
      return undefined;
    }
    const prevCodeLines = renderCache.result.code.length;
    renderCache.result.code.length = lineCount;
    for (let i = prevCodeLines; i < lineCount; i++) {
      renderCache.result.code[i] = {
        type: 'element',
        tagName: 'div',
        properties: {
          'data-line': i + 1,
          'data-line-type': 'context',
          'data-line-index': i,
        },
        children: [{ type: 'text', value: ' ' }],
      };
    }
    this.alternateLineCount.set(renderCache.file, lineCount);
    if (newLineAnnotations != null) {
      this.setLineAnnotations(newLineAnnotations);
    }
    return this.processFileResult(
      renderCache.file,
      renderRange,
      renderCache.result
    );
  }

  public renderFile(
    file: FileContents | undefined = this.renderCache?.file,
    renderRange: RenderRange = DEFAULT_RENDER_RANGE
  ): FileRenderResult | undefined {
    if (file == null) {
      return undefined;
    }
    const cache = this.workerManager?.getFileResultCache(file);
    if (cache != null && this.renderCache == null) {
      this.renderCache = {
        file,
        highlighted: true,
        renderRange: undefined,
        ...cache,
      };
    }
    const { options, forceRender } = this.getRenderOptions(file);
    this.renderCache ??= {
      file,
      highlighted: false,
      options,
      result: undefined,
      renderRange: undefined,
    };
    if (this.workerManager?.isWorkingPool() === true) {
      // Cache invalidation based on renderRange comparison
      if (
        this.renderCache.result == null ||
        (!this.renderCache.highlighted &&
          (file !== this.renderCache.file ||
            !areRenderRangesEqual(this.renderCache.renderRange, renderRange)))
      ) {
        this.renderCache.file = file;
        this.renderCache.result = this.workerManager.getPlainFileAST(
          file,
          renderRange.startingLine,
          renderRange.totalLines,
          this.getOrCreateLineOffsets(file)
        );
        this.renderCache.renderRange = renderRange;
      }

      if (
        // We should only attempt to kick off the worker highlighter if there
        // are lines to render
        renderRange.totalLines > 0 &&
        (!this.renderCache.highlighted || forceRender)
      ) {
        this.workerManager.highlightFileAST(this, file);
      }
    } else {
      this.computedLang = file.lang ?? getFiletypeFromFileName(file.name);
      const hasThemes =
        this.highlighter != null && areThemesAttached(options.theme);
      const hasLangs =
        this.highlighter != null && areLanguagesAttached(this.computedLang);

      // If we have any semblance of a highlighter with the correct theme(s)
      // attached, we can kick off some form of rendering.  If we don't have
      // the correct language, then we can render plain text and after kick off
      // an async job to get the highlighted AST
      if (
        this.highlighter != null &&
        hasThemes &&
        (forceRender ||
          (!this.renderCache.highlighted && hasLangs) ||
          this.renderCache.result == null)
      ) {
        const { result, options } = this.renderFileWithHighlighter(
          file,
          this.highlighter,
          !hasLangs
        );
        this.renderCache = {
          file,
          options,
          highlighted: hasLangs,
          result,
          renderRange: undefined,
        };
      }

      // If we get in here it means we'll have to kick off an async highlight
      // process which will involve initializing the highlighter with new themes
      // and languages
      if (!hasThemes || !hasLangs) {
        void this.asyncHighlight(file).then(({ result, options }) => {
          // In this case we need to force a re-render, so we can do that by
          // reaching into renderCache
          if (this.renderCache != null) {
            this.renderCache.highlighted = false;
          }
          this.onHighlightSuccess(file, result, options);
        });
      }
    }

    return this.renderCache.result != null
      ? this.processFileResult(
          this.renderCache.file,
          renderRange,
          this.renderCache.result
        )
      : undefined;
  }

  async asyncRender(
    file: FileContents,
    renderRange: RenderRange = DEFAULT_RENDER_RANGE
  ): Promise<FileRenderResult> {
    const { result } = await this.asyncHighlight(file);
    return this.processFileResult(file, renderRange, result);
  }

  private async asyncHighlight(file: FileContents): Promise<RenderFileResult> {
    this.computedLang = file.lang ?? getFiletypeFromFileName(file.name);
    const hasThemes =
      this.highlighter != null &&
      hasResolvedThemes(getThemes(this.options.theme));
    const hasLangs =
      this.highlighter != null && areLanguagesAttached(this.computedLang);
    // If we don't have the required langs or themes, then we need to
    // initialize the highlighter to load the appropriate languages and themes
    if (this.highlighter == null || !hasThemes || !hasLangs) {
      this.highlighter = await this.initializeHighlighter();
    }
    return this.renderFileWithHighlighter(file, this.highlighter);
  }

  private renderFileWithHighlighter(
    file: FileContents,
    highlighter: DiffsHighlighter,
    forcePlainText = false
  ): RenderFileResult {
    const { options } = this.getRenderOptions(file);
    const result = renderFileWithHighlighter(file, highlighter, options, {
      forcePlainText,
    });
    return { result, options };
  }

  private processFileResult(
    file: FileContents,
    renderRange: RenderRange,
    { code, themeStyles, baseThemeType }: ThemedFileResult
  ): FileRenderResult {
    const totalLines = this.getLineCount(file);
    const { disableFileHeader = false } = this.options;
    const contentArray: ElementContent[] = [];
    const gutter = createGutterWrapper();
    const endLine = Math.min(
      renderRange.startingLine + renderRange.totalLines,
      totalLines
    );
    let rowCount = 0;

    for (
      let lineIndex = renderRange.startingLine;
      lineIndex < endLine;
      lineIndex++
    ) {
      const lineNumber = lineIndex + 1;

      // Sparse array - directly indexed by lineIndex
      const line = code[lineIndex];
      if (line == null) {
        const message = 'FileRenderer.processFileResult: Line doesnt exist';
        console.error(message, {
          name: file.name,
          lineIndex,
          lineNumber,
        });
        throw new Error(message);
      }

      // Add gutter line number
      gutter.children.push(
        createGutterItem('context', lineNumber, `${lineIndex}`)
      );
      contentArray.push(line);
      rowCount++;

      // Check annotations using ACTUAL line number from file
      const annotations = this.lineAnnotations[lineNumber];
      if (annotations != null) {
        gutter.children.push(createGutterGap('context', 'annotation', 1));
        contentArray.push(
          createAnnotationElement({
            type: 'annotation',
            hunkIndex: 0,
            lineIndex: lineNumber,
            annotations: annotations.map((annotation) =>
              getLineAnnotationName(annotation)
            ),
          })
        );
        rowCount++;
      }
    }

    // Finalize: wrap gutter and content
    gutter.properties.style = `grid-row: span ${rowCount}`;
    return {
      gutterAST: gutter.children ?? [],
      contentAST: contentArray,
      preAST: this.createPreElement(totalLines),
      headerAST: !disableFileHeader ? this.renderHeader(file) : undefined,
      totalLines,
      rowCount,
      themeStyles: themeStyles,
      baseThemeType,
      bufferBefore: renderRange.bufferBefore,
      bufferAfter: renderRange.bufferAfter,
      css: '',
    };
  }

  private renderHeader(file: FileContents) {
    const { headerRenderMode = 'default' } = this.options;
    return createFileHeaderElement({
      fileOrDiff: file,
      mode: headerRenderMode,
    });
  }

  public renderFullHTML(result: FileRenderResult): string {
    return toHtml(this.renderFullAST(result));
  }

  public renderFullAST(
    result: FileRenderResult,
    children: ElementContent[] = []
  ): HASTElement {
    children.push(
      createHastElement({
        tagName: 'code',
        children: this.renderCodeAST(result),
        properties: { 'data-code': '' },
      })
    );
    return { ...result.preAST, children };
  }

  public renderCodeAST(result: FileRenderResult): ElementContent[] {
    const gutter = createGutterWrapper();
    gutter.children = result.gutterAST;
    gutter.properties.style = `grid-row: span ${result.rowCount}`;
    const contentColumn = createContentColumn(
      result.contentAST,
      result.rowCount
    );
    return [gutter, contentColumn];
  }

  public renderPartialHTML(
    children: ElementContent[],
    includeCodeNode: boolean = false
  ): string {
    if (!includeCodeNode) {
      return toHtml(children);
    }
    return toHtml(
      createHastElement({
        tagName: 'code',
        children,
        properties: { 'data-code': '' },
      })
    );
  }

  public async initializeHighlighter(): Promise<DiffsHighlighter> {
    this.highlighter = await getSharedHighlighter(
      getHighlighterOptions(this.computedLang, this.options)
    );
    return this.highlighter;
  }

  public onHighlightSuccess(
    file: FileContents,
    result: ThemedFileResult,
    options: RenderFileOptions
  ): void {
    if (this.renderCache == null) {
      return;
    }
    const triggerRenderUpdate =
      this.renderCache.file !== file ||
      !this.renderCache.highlighted ||
      !areRenderOptionsEqual(options, this.renderCache.options);

    this.renderCache = {
      file,
      options,
      highlighted: true,
      result,
      renderRange: undefined,
    };

    if (triggerRenderUpdate) {
      this.onRenderUpdate?.();
    }
  }

  public onHighlightError(error: unknown): void {
    console.error(error);
  }

  private createPreElement(totalLines: number): HASTElement {
    const { disableLineNumbers = false, overflow = 'scroll' } = this.options;
    return createPreElement({
      type: 'file',
      diffIndicators: 'none',
      disableBackground: true,
      disableLineNumbers,
      overflow,
      split: false,
      totalLines,
    });
  }
}

function areRenderOptionsEqual(
  optionsA: RenderFileOptions,
  optionsB: RenderFileOptions
): boolean {
  return (
    areThemesEqual(optionsA.theme, optionsB.theme) &&
    optionsA.useTokenTransformer === optionsB.useTokenTransformer &&
    optionsA.tokenizeMaxLineLength === optionsB.tokenizeMaxLineLength
  );
}
