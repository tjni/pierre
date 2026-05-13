let _isMacLike: boolean | undefined = undefined;
let _isLinux: boolean | undefined = undefined;

export function isMacLike(): boolean {
  return (
    _isMacLike ??
    (_isMacLike = /macOS|MacIntel|iPhone|iPad|iPod/i.test(getPlatform()))
  );
}

export function isLinux(): boolean {
  return _isLinux ?? (_isLinux = /Linux/i.test(getPlatform()));
}

export function isPrimaryModifier(
  { metaKey, ctrlKey }: MouseEvent | KeyboardEvent,
  isMac: boolean = isMacLike()
): boolean {
  return isMac ? metaKey && !ctrlKey : ctrlKey && !metaKey;
}

function getPlatform(): string {
  const navigator = globalThis.navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return navigator?.platform ?? navigator?.userAgentData?.platform ?? 'unknown';
}
