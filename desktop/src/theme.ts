/** Electron's theme source for the app's theme from the bridge; anything unexpected follows the OS. */
export function themeSource(theme: unknown): 'system' | 'light' | 'dark' {
  const preference = (theme as { preference?: unknown } | null)?.preference;
  return preference === 'light' || preference === 'dark' ? preference : 'system';
}
