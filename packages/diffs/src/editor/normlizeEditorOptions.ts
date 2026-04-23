const DEFAULT_FONT_FAMILY =
  "'SF Mono', Monaco, Consolas, 'Ubuntu Mono', 'Liberation Mono', 'Courier New', monospace";
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_LINE_HEIGHT = 20;
const DEFAULT_PADDING_Y = 10;

function getRootCssVariableValue(variableName: string): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(variableName)
    .trim();
  return value.length > 0 ? value : undefined;
}

function parseCssNumber(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface EditorTypographyOptions {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  paddingY?: number;
  tabSize?: number;
}

export interface NormalizedEditorOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  paddingY: number;
  tabSize: number;
}

export function normlizeEditorOptions(
  options: EditorTypographyOptions = {}
): NormalizedEditorOptions {
  const fontFamily =
    options.fontFamily ??
    getRootCssVariableValue('--diffs-font-family') ??
    getRootCssVariableValue('--diffs-font-fallback') ??
    DEFAULT_FONT_FAMILY;

  const fontSize =
    options.fontSize ??
    parseCssNumber(getRootCssVariableValue('--diffs-font-size') ?? '') ??
    DEFAULT_FONT_SIZE;

  const lineHeight =
    options.lineHeight ??
    parseCssNumber(getRootCssVariableValue('--diffs-line-height') ?? '') ??
    DEFAULT_LINE_HEIGHT;

  const paddingY = Math.max(0, options.paddingY ?? DEFAULT_PADDING_Y);
  const tabSize = Math.max(
    1,
    Math.floor(
      options.tabSize ??
        parseCssNumber(getRootCssVariableValue('--diffs-tab-size') ?? '') ??
        2
    )
  );

  return {
    fontFamily,
    fontSize,
    lineHeight,
    paddingY,
    tabSize,
  };
}
