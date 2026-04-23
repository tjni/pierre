export function getVisualColumn(
  text: string,
  character: number,
  tabSize: number
): number {
  const clampedCharacter = Math.max(0, Math.min(character, text.length));
  const normalizedTabSize = Math.max(1, Math.floor(tabSize));
  let column = 0;
  for (let i = 0; i < clampedCharacter; i++) {
    if (text.charCodeAt(i) === 9) {
      const remainder = column % normalizedTabSize;
      column +=
        remainder === 0 ? normalizedTabSize : normalizedTabSize - remainder;
      continue;
    }
    column++;
  }
  return column;
}
