/**
 * An Enter pressed while an IME (Chinese/Japanese) is composing must not count as "send".
 * Chrome sets isComposing to true; but macOS WebKit (the WKWebView in Magpie's desktop window, Safari)
 * already reports isComposing false on the keydown that confirms a candidate with Enter, so keyCode 229 is the only signal.
 */
export function isImeComposing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return !!e.isComposing || e.keyCode === 229;
}
