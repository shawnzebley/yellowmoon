/** True inside a Tauri window; false in a plain browser, Vitest or Playwright. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * True on Windows (the Windows port): the window has a native title bar there, so there are no
 * traffic lights to keep clear of, and there is no in-app updater (new versions come from the
 * fork's GitHub Releases).
 */
export function isWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}
