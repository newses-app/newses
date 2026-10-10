/**
 * In the apps, http(s) links to other origins open in the system browser instead of navigating
 * the app: entry content, original articles, and share links alike. Returns a function that stops.
 */
export function routeExternalLinks(doc: Document, open: (url: string) => void): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || (event.type === 'auxclick' && event.button !== 1)) return;
    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest('a[href]');
    const href = anchor?.getAttribute('href');
    if (!href) return;
    const url = new URL(href, doc.baseURI);
    if (url.origin === new URL(doc.baseURI).origin) return;
    // Anything else (mailto:, javascript:) never runs in the app.
    event.preventDefault();
    if (url.protocol === 'https:' || url.protocol === 'http:') open(url.href);
  };
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('auxclick', onClick, true);
  return () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('auxclick', onClick, true);
  };
}
