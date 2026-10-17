/** A proxied image path's last segment is its URL, base64url-encoded. */
const PROXIED = /\/api\/v1\/images\/[^/]+\/([\w-]+)$/;

/** The image URL behind a proxied path (relative or absolute); other URLs as they are. */
export function originalImageUrl(src: string): string {
  const match = PROXIED.exec(src.split(/[?#]/)[0] ?? '');
  if (!match?.[1]) return src;
  try {
    const binary = atob(match[1].replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return src;
  }
}

/**
 * Points images in entry HTML at copies stored on the device (`blob:` URLs), by their original
 * URL whether or not the HTML was proxied. Their `srcset`, `sizes`, and picture sources go, so the
 * browser cannot pick a version that is not stored. With `storedOnly` (no connection), images
 * without a stored copy lose their sources too, so nothing is requested.
 */
export function withStoredImages(
  html: string,
  stored: ReadonlyMap<string, string>,
  storedOnly = false,
): string {
  if (stored.size === 0 && !storedOnly) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  let changed = false;
  for (const img of doc.querySelectorAll('img')) {
    const local = stored.get(originalImageUrl(img.getAttribute('src') ?? ''));
    if (!local && !storedOnly) continue;
    if (local) img.setAttribute('src', local);
    else img.removeAttribute('src');
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    for (const source of img.closest('picture')?.querySelectorAll('source') ?? []) source.remove();
    changed = true;
  }
  if (storedOnly)
    for (const source of doc.querySelectorAll('picture source')) {
      source.remove();
      changed = true;
    }
  for (const video of doc.querySelectorAll('video[poster]')) {
    const local = stored.get(originalImageUrl(video.getAttribute('poster') ?? ''));
    if (local) video.setAttribute('poster', local);
    else if (storedOnly) video.removeAttribute('poster');
    else continue;
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}

/**
 * Entry HTML as the server serves it to readers who proxy images: each image at its proxy path,
 * or without a source when it has none. Responsive candidates go, as they are not proxied here.
 */
export function proxiedHtml(html: string, proxies: ReadonlyMap<string, string>): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const img of doc.querySelectorAll('img')) {
    const proxy = proxies.get(img.getAttribute('src') ?? '');
    if (proxy) img.setAttribute('src', proxy);
    else img.removeAttribute('src');
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
  }
  for (const source of doc.querySelectorAll('picture source')) source.remove();
  for (const video of doc.querySelectorAll('video[poster]')) {
    const proxy = proxies.get(video.getAttribute('poster') ?? '');
    if (proxy) video.setAttribute('poster', proxy);
    else video.removeAttribute('poster');
  }
  return doc.body.innerHTML;
}
