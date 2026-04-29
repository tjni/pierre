export function cleanLastNewline(contents: string): string {
  let end = contents.length;
  if (contents.charAt(end - 1) === '\n') {
    end--;
    if (contents.charAt(end - 1) === '\r') {
      end--;
    }
  }
  return contents.slice(0, end);
}
