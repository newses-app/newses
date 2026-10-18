/** Electron's theme source for the app's theme from the bridge; anything unexpected follows the OS. */
export function themeSource(theme: unknown): 'system' | 'light' | 'dark' {
  const preference = (theme as { preference?: unknown } | null)?.preference;
  return preference === 'light' || preference === 'dark' ? preference : 'system';
}

function hexColor(theme: unknown, key: 'background' | 'text'): string | null {
  const color = (theme as Record<string, unknown> | null)?.[key];
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
}

/** The app theme's background, `#rrggbb`, from the bridge or settings; null for anything else. */
export const themeBackground = (theme: unknown) => hexColor(theme, 'background');

/** The app theme's text colour, `#rrggbb`, from the bridge or settings; null for anything else. */
export const themeText = (theme: unknown) => hexColor(theme, 'text');
