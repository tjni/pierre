export type MatchRange = [startOffset: number, endOffset: number];

export interface SearchParams {
  text: string;
  replaceText: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchPosition {
  readonly line: number;
  readonly character: number;
}

export interface LineByLineSearchDocument {
  readonly textLength: number;
  readonly lineCount: number;
  getLineText(line: number): string;
  getLineStartOffset(line: number): number;
  charAt(offset: number): string;
}

export const MAX_FIND_MATCHES = 100000;

// TODO(ije): use Intl.Segmenter instead of regex for word separators
const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?' as const;

export function searchLineByLine(
  document: LineByLineSearchDocument,
  searchParams: SearchParams,
  limit: number = MAX_FIND_MATCHES
): MatchRange[] {
  if (searchParams.text.length === 0 || document.textLength === 0) {
    return [];
  }

  // Search currently operates line-by-line, so newline-spanning patterns are unsupported.
  if (isNewlineSpanningSearch(searchParams.text, searchParams.regex)) {
    return [];
  }

  let pattern: RegExp;
  try {
    pattern = compileSearchRegExp(
      searchParams.text,
      searchParams.regex,
      searchParams.caseSensitive
    );
  } catch {
    return [];
  }

  return collectSearchMatchesLineByLine(
    document,
    pattern,
    searchParams.wholeWord,
    limit
  );
}

/** Expands `$&`, `$1`, `$$`, etc. in a regex replace string using a match. */
export function buildSearchReplacementText(
  positionAt: (offset: number) => SearchPosition,
  offsetAt: (position: SearchPosition) => number,
  getLineText: (line: number) => string,
  searchParams: SearchParams,
  matchStart: number,
  matchEnd: number
): string {
  if (!searchParams.regex) {
    return searchParams.replaceText;
  }

  const position = positionAt(matchStart);
  const lineText = getLineText(position.line);
  const lineStart = offsetAt({ line: position.line, character: 0 });
  const relStart = matchStart - lineStart;
  const matched = lineText.slice(relStart, relStart + (matchEnd - matchStart));

  let pattern: RegExp;
  try {
    pattern = compileSearchRegExp(
      searchParams.text,
      true,
      searchParams.caseSensitive
    );
  } catch {
    return searchParams.replaceText;
  }

  const re = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  const match = re.exec(matched);
  if (match === null || match[0].length !== matched.length) {
    return searchParams.replaceText;
  }
  return expandReplaceString(searchParams.replaceText, match);
}

function isNewlineSpanningSearch(text: string, isRegex: boolean): boolean {
  return (
    text.includes('\n') ||
    text.includes('\r') ||
    (isRegex && (text.includes('\\n') || text.includes('\\r')))
  );
}

function collectSearchMatchesLineByLine(
  document: LineByLineSearchDocument,
  pattern: RegExp,
  wholeWord: boolean,
  limit: number
): MatchRange[] {
  const out: MatchRange[] = [];
  const charAt = (offset: number) => document.charAt(offset);

  for (let line = 0; line < document.lineCount; line++) {
    const lineText = document.getLineText(line);
    const lineStart = document.getLineStartOffset(line);
    const re = new RegExp(pattern.source, pattern.flags);
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(lineText)) !== null) {
      const rel = match.index;
      const fragment = match[0];
      if (fragment.length === 0) {
        re.lastIndex = advancePastEmptyMatch(lineText, rel);
        continue;
      }
      const docStart = lineStart + rel;
      if (
        !wholeWord ||
        isWholeWordAtDocOffsets(
          docStart,
          fragment.length,
          document.textLength,
          charAt
        )
      ) {
        out.push([docStart, docStart + fragment.length]);
        if (out.length >= limit) {
          return out;
        }
      }
      if (rel === re.lastIndex) {
        re.lastIndex = advancePastEmptyMatch(lineText, rel);
      }
    }
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileSearchRegExp(
  source: string,
  isRegex: boolean,
  caseSensitive: boolean
): RegExp {
  const body = isRegex ? source : escapeRegExp(source);
  const flags = `g${caseSensitive ? '' : 'i'}${isRegex ? 'm' : ''}`;
  return new RegExp(body, flags);
}

function isWordSeparatorCharCode(charCode: number): boolean {
  if (charCode <= 32 || charCode === 127) {
    return true;
  }
  const ch = String.fromCharCode(charCode);
  return WORD_SEPARATORS.includes(ch);
}

// Checks if the given text is a whole word by checking if the
// characters before and after are word separators.
function isWholeWordAtDocOffsets(
  docStart: number,
  length: number,
  docLength: number,
  charAt: (offset: number) => string
): boolean {
  const beforeOk =
    docStart <= 0 ||
    isWordSeparatorCharCode(charCodeUnitAt(charAt, docStart - 1));
  const afterOk =
    docStart + length >= docLength ||
    isWordSeparatorCharCode(charCodeUnitAt(charAt, docStart + length));
  return beforeOk && afterOk;
}

function charCodeUnitAt(
  charAt: (offset: number) => string,
  offset: number
): number {
  const unit = charAt(offset);
  return unit.length === 0 ? 0 : unit.charCodeAt(0);
}

function expandReplaceString(
  replacement: string,
  match: RegExpExecArray
): string {
  return replacement.replace(/\$([$&]|\d+)/g, (_token, group: string) => {
    if (group === '$') {
      return '$';
    }
    if (group === '&') {
      return match[0] ?? '';
    }
    const index = Number(group);
    return match[index] ?? '';
  });
}

function advancePastEmptyMatch(text: string, index: number): number {
  if (index + 1 < text.length) {
    const first = text.charCodeAt(index);
    const second = text.charCodeAt(index + 1);
    if (
      first >= 0xd800 &&
      first <= 0xdbff &&
      second >= 0xdc00 &&
      second <= 0xdfff
    ) {
      return index + 2;
    }
  }
  return index + 1;
}
