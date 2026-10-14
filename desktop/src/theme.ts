/** Electron's theme source for the app's theme from the bridge; anything unexpected follows the OS. */
export function themeSource(theme: unknown): 'system' | 'light' | 'dark' {
  const preference = (theme as { preference?: unknown } | null)?.preference;
  return preference === 'light' || preference === 'dark' ? preference : 'system';
}

/** The app theme's background, `#rrggbb`, from the bridge or settings; null for anything else. */
export function themeBackground(theme: unknown): string | null {
  const background = (theme as { background?: unknown } | null)?.background;
  return typeof background === 'string' && /^#[0-9a-f]{6}$/i.test(background) ? background : null;
}
