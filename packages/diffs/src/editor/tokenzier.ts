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

/** Stoppable background tokenizer */
export class BackgroundTokenizer {
  #grammar: IGrammar;
  #colorMap: { dark: string[]; light: string[] };
  #textDocument: TextDocument;
  #messageKey: string;
  #onMessage: (event: MessageEvent) => void;
  #onTokenize: (result: {
    lines: Map<number, Array<HighlightedToken>>;
  }) => void;

  // state
  #isFinished: boolean = true;
  #lastLine: number = -1;
  #lastState: StateStack | null = null;

  constructor({
    grammar,
    colorMap,
    textDocument,
    onTokenize,
    linesPreTokenize,
  }: BackgroundTokenizerOptions) {
    this.#grammar = grammar;
    this.#colorMap = colorMap;
    this.#textDocument = textDocument;
    this.#onTokenize = onTokenize;
    this.#onMessage = ({ data }: MessageEvent) => {
      if (data === this.#messageKey) {
        this.#doTokenize(linesPreTokenize);
      }
    };
    this.#messageKey = 'tokenize-' + Date.now().toString(16);
    addEventListener('message', this.#onMessage);
  }

  scheduleTokenize(startLine: number, state: StateStack): void {
    this.#isFinished = false;
    this.#lastLine = startLine;
    this.#lastState = state;
    postMessage(this.#messageKey);
  }

  cancelBackgroundTask(): void {
    removeEventListener('message', this.#onMessage);
    this.#isFinished = true;
    this.#lastLine = -1;
    this.#lastState = null;
  }

  #doTokenize(linesPreTokenize: number = TOKENIZE_LINES_PRE_TOKENIZE): void {
    if (this.#isFinished || this.#lastState === null) {
      return;
    }

    const lines = new Map<number, Array<HighlightedToken>>();
    const totalLines = this.#textDocument.lineCount;
    const endLine = Math.min(this.#lastLine + linesPreTokenize, totalLines);

    let line = this.#lastLine;
    let state = this.#lastState;
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
    if (line >= totalLines) {
      this.cancelBackgroundTask();
      return;
    }

    this.#lastLine = line;
    this.#lastState = state;
    postMessage(this.#messageKey);
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
