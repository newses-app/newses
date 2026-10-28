/**
 * Entry HTML whose images load as they near the viewport and decode off the main thread, so a
 * long article does not fetch every image at once. The sanitiser drops `loading`, so stored
 * entries carry none; this applies to all of them, `blob:` copies on the device included.
 */
export function withLazyImages(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const images = doc.querySelectorAll('img');
  if (images.length === 0) return html;
  for (const img of images) {
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
  }
  return doc.body.innerHTML;
}
