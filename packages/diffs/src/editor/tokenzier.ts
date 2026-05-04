import {
  EncodedTokenMetadata,
  type IGrammar,
  type StateStack,
} from 'shiki/textmate';

import type { HighlightedToken } from '../types';
import {
  TOKENIZE_LINES_PRE_TOKENIZE,
  TOKENIZE_MAX_LINE_LENGTH,
  TOKENIZE_TIME_LIMIT,
} from './constants';
import type { TextDocument } from './textDocument';

export interface BackgroundTokenizerOptions {
  grammar: IGrammar;
  colorMap: { dark: string[]; light: string[] };
  textDocument: TextDocument;
  onTokenize: (result: { lines: Map<number, Array<HighlightedToken>> }) => void;
  linesPreTokenize?: number; // default to 50
}

/** Stopable background tokenizer */
export class BackgroundTokenizer {
  #grammar: IGrammar;
  #colorMap: { dark: string[]; light: string[] };
  #textDocument: TextDocument;
  #onTokenize: (result: {
    lines: Map<number, Array<HighlightedToken>>;
  }) => void;
  #linesPreTokenize: number;
  #isFinished: boolean = true;
  #nextFrameId: number | null = null;

  constructor({
    grammar,
    colorMap,
    textDocument,
    onTokenize,
    linesPreTokenize = TOKENIZE_LINES_PRE_TOKENIZE,
  }: BackgroundTokenizerOptions) {
    this.#grammar = grammar;
    this.#colorMap = colorMap;
    this.#textDocument = textDocument;
    this.#onTokenize = onTokenize;
    this.#linesPreTokenize = linesPreTokenize;
  }

  scheduleTokenize(startLine: number, state: StateStack): void {
    this.#isFinished = false;
    this.#nextFrameId = requestAnimationFrame(() => {
      this.#doTokenize(startLine, state);
    });
  }

  cancelBackgroundTask(): void {
    if (this.#nextFrameId !== null) {
      cancelAnimationFrame(this.#nextFrameId);
      this.#nextFrameId = null;
    }
    this.#isFinished = true;
  }

  #doTokenize(startLine: number, state: StateStack): void {
    this.#nextFrameId = null;
    if (this.#isFinished) {
      return;
    }

    const lines = new Map<number, Array<HighlightedToken>>();
    const endLine = Math.min(
      startLine + this.#linesPreTokenize,
      this.#textDocument.lineCount
    );

    let line = startLine;
    for (; line < endLine; line++) {
      const lineText = this.#textDocument.getLineText(line);
      if (lineText.length > TOKENIZE_MAX_LINE_LENGTH) {
        console.warn(
          `[diffs] Line(${line}) too long to tokenize: ${lineText.length}`
        );
        lines.set(line, [[0, '', lineText]]);
        continue;
      }

      if (lineText === '' || lineText.trim() === '') {
        lines.set(line, [[0, '', lineText === '' ? ' ' : lineText]]);
        continue;
      }

      const ret = tokenizeLine(
        this.#grammar,
        this.#colorMap,
        lineText,
        state,
        TOKENIZE_TIME_LIMIT
      );
      lines.set(line, ret.resolvedTokens);
      state = ret.ruleStack;
    }

    this.#onTokenize({ lines });
    if (line >= this.#textDocument.lineCount) {
      this.#isFinished = true;
      return;
    }

    // schedule the next tokenize
    this.#nextFrameId = requestAnimationFrame(() => {
      this.#doTokenize(line, state);
    });
  }
}

export function tokenizeLine(
  grammar: IGrammar,
  colorMap: { dark: string[]; light: string[] },
  lineText: string,
  stateStack: StateStack,
  timeLimit?: number
): {
  ruleStack: StateStack;
  resolvedTokens: Array<HighlightedToken>;
} {
  const result = grammar.tokenizeLine2(lineText, stateStack, timeLimit);
  if (result.stoppedEarly) {
    console.warn(
      `[diffs] Time limit reached when tokenizing line: ${lineText.substring(0, 100)}`
    );
  }
  const rawTokens = result.tokens;
  const tokensLength = rawTokens.length / 2;
  const resolvedTokens: Array<HighlightedToken> = [];
  for (let j = 0; j < tokensLength; j++) {
    const offset = rawTokens[2 * j];
    const nextOffset =
      j + 1 < tokensLength ? rawTokens[2 * j + 2] : lineText.length;
    if (offset === nextOffset) {
      // should never reach here, skip if happens anyway
      continue;
    }
    const metadata = rawTokens[2 * j + 1];
    const bg = EncodedTokenMetadata.getForeground(metadata);
    const darkFG = colorMap.dark[bg];
    const lightFG = colorMap.light[bg];
    const cssText = `--diffs-token-dark:${darkFG};--diffs-token-light:${lightFG}`;
    const tokenText = lineText.slice(offset, nextOffset);
    resolvedTokens.push([offset, cssText, tokenText]);
  }
  return {
    ruleStack: result.ruleStack,
    resolvedTokens,
  };
}
