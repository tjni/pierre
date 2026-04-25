import type { EditorOptions } from '../components/Editor';
import { getRootCssVariableValue, parseCssValue } from './editorUtils';

const DEFAULT_FONT_FAMILY =
  "'SF Mono', Monaco, Consolas, 'Ubuntu Mono', 'Liberation Mono', 'Courier New', monospace";
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_LINE_HEIGHT = 20;
const DEFAULT_PADDING_Y = 10;
const DEFAULT_MIN_NUMBER_COLUMN_WIDTH = 3;

export interface NormalizedEditorOptions extends EditorOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  paddingY: number;
  tabSize: number;
  minNumberColumnWidth: number;
}

export function normlizeEditorOptions(
  options: EditorOptions = {}
): NormalizedEditorOptions {
  const fontFamily =
    options.fontFamily ??
    getRootCssVariableValue('--diffs-font-family') ??
    getRootCssVariableValue('--diffs-font-fallback') ??
    DEFAULT_FONT_FAMILY;
  const fontSize = Math.max(
    10,
    options.fontSize ??
      getCssVariableAsNumber('--diffs-font-size') ??
      DEFAULT_FONT_SIZE
  );
  const lineHeight = Math.max(
    12,
    options.lineHeight ??
      getLineHeightFromCssVariable('--diffs-line-height', fontSize) ??
      DEFAULT_LINE_HEIGHT
  );
  const paddingY = Math.max(0, options.paddingY ?? DEFAULT_PADDING_Y);
  const tabSize = Math.max(
    1,
    Math.floor(
      options.tabSize ?? getCssVariableAsNumber('--diffs-tab-size') ?? 2
    )
  );
  const minNumberColumnWidth = Math.max(
    1,
    getCssVariableAsNumber('--diffs-min-number-column-width') ??
      options.minNumberColumnWidth ??
      DEFAULT_MIN_NUMBER_COLUMN_WIDTH
  );

  return {
    ...options,
    fontFamily,
    fontSize,
    lineHeight,
    paddingY,
    tabSize,
    minNumberColumnWidth,
  };
}

function getCssVariableAsNumber(variableName: string): number | undefined {
  const cssPropertyValue = getRootCssVariableValue(variableName);
  if (cssPropertyValue === '' || cssPropertyValue === undefined) {
    return undefined;
  }
  return parseCssValue(cssPropertyValue)[0];
}

function getLineHeightFromCssVariable(
  variableName: string,
  fontSize: number
): number | undefined {
  const cssPropertyValue = getRootCssVariableValue(variableName);
  if (cssPropertyValue === '' || cssPropertyValue === undefined) {
    return undefined;
  }
  const [value, unit] = parseCssValue(cssPropertyValue);
  if (unit === 'px') {
    return value;
  }
  if (unit === '' || unit === 'em') {
    return value * fontSize;
  }
  // unsupported units
  return undefined;
}
