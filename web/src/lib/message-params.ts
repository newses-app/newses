/** A message as plain data, for text that is stored rather than shown. */
export const withoutIsolates = (text: string) => text.replace(/[\u2068\u2069]/g, '');
