import en from './locales/en.json' with { type: 'json' };

/** Text of the app's own menus; what the window shows comes from the web app's locale files. */
export function t(key: keyof typeof en, params: Record<string, string> = {}): string {
  return en[key].replace(/\{(\w+)\}/g, (_match, name: string) => params[name] ?? '');
}
