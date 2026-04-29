import { DEFAULT_THEMES } from '../constants';
import type {
  CodeToHastOptions,
  DiffsHighlighter,
  DiffsThemeNames,
  FileContents,
  FileContentsWithLineOffsets,
  ForceFilePlainTextOptions,
  RenderFileOptions,
  ThemedFileResult,
} from '../types';
import { cleanLastNewline } from './cleanLastNewline';
import { computeLineOffsets } from './computeFileOffsets';
import { createTransformerWithState } from './createTransformerWithState';
import { formatCSSVariablePrefix } from './formatCSSVariablePrefix';
import { getFiletypeFromFileName } from './getFiletypeFromFileName';
import { getHighlighterThemeStyles } from './getHighlighterThemeStyles';
import { getLineNodes } from './getLineNodes';

const DEFAULT_PLAIN_TEXT_OPTIONS: ForceFilePlainTextOptions = {
  forcePlainText: false,
};

export function renderFileWithHighlighter(
  file: FileContents,
  highlighter: DiffsHighlighter,
  {
    theme = DEFAULT_THEMES,
    tokenizeMaxLineLength,
    useTokenTransformer,
  }: RenderFileOptions,
  {
    forcePlainText,
    startingLine,
    totalLines,
    lines,
  }: ForceFilePlainTextOptions = DEFAULT_PLAIN_TEXT_OPTIONS
): ThemedFileResult {
  if (forcePlainText) {
    startingLine ??= 0;
    totalLines ??= Infinity;
  } else {
    // If we aren't forcing plain text, then we intentionally do not support
    // ranges for highlighting as that could break the syntax highlighting, we
    // we override any values that may have been passed in.  Maybe one day we
    // warn about this?
    startingLine = 0;
    totalLines = Infinity;
  }
  const isWindowedHighlight = startingLine > 0 || totalLines < Infinity;
  const { state, transformers } =
    createTransformerWithState(useTokenTransformer);
  const lang = forcePlainText
    ? 'text'
    : (file.lang ?? getFiletypeFromFileName(file.name));
  const baseThemeType =
    typeof theme === 'string' ? highlighter.getTheme(theme).type : undefined;
  const themeStyles = getHighlighterThemeStyles({
    theme,
    highlighter,
  });
  state.lineInfo = (shikiLineNumber: number) => ({
    type: 'context',
    lineIndex: shikiLineNumber - 1 + startingLine,
    lineNumber: shikiLineNumber + startingLine,
  });
  const hastConfig: CodeToHastOptions<DiffsThemeNames> = (() => {
    if (typeof theme === 'string') {
      return {
        lang,
        theme,
        transformers,
        defaultColor: false,
        cssVariablePrefix: formatCSSVariablePrefix('token'),
        tokenizeMaxLineLength,
      };
    }
    return {
      lang,
      themes: theme,
      transformers,
      defaultColor: false,
      cssVariablePrefix: formatCSSVariablePrefix('token'),
      tokenizeMaxLineLength,
    };
  })();
  const highlightedLines = getLineNodes(
    // TODO(@ije): use `grammar.tokenizeLine2` to replace `codeToHast` for better performance,
    // use lines.offsets for line text extraction without concatenating strings
    highlighter.codeToHast(
      isWindowedHighlight
        ? extractWindowedFileContent(
            lines ?? computeLineOffsets(file),
            startingLine,
            totalLines
          )
        : cleanLastNewline(file.contents),
      hastConfig
    )
  );

  // Create sparse array for windowed rendering
  const code = isWindowedHighlight ? new Array(startingLine) : highlightedLines;
  if (isWindowedHighlight) {
    code.push(...highlightedLines);
  }

  return { code, themeStyles, baseThemeType };
}

function extractWindowedFileContent(
  lines: FileContentsWithLineOffsets,
  startingLine: number,
  totalLines: number
): string {
  if (lines.lineCount === 0) {
    return '';
  }
  const endLine = Math.min(startingLine + totalLines, lines.lineCount);
  const startOffset = lines.offsets[startingLine] ?? lines.contents.length;
  const endOffset = lines.offsets[endLine] ?? lines.contents.length;
  return lines.contents.slice(startOffset, endOffset);
}
