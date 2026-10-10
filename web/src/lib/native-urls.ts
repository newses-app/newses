import type { Subscription } from '@rss-reader/shared';

/*
 * The API gives server-relative URLs (icons, proxied images). The apps run on their own origin, so
 * they make them absolute against the server; `server` is null in the browser, where they work as is.
 */

const serverRelative = (value: string) => value.startsWith('/') && !value.startsWith('//');

export const absolute = (url: string, server: string | null) =>
  server && serverRelative(url) ? new URL(url, server).href : url;

/**
 * Where to load a subscription's icon. The browser uses the API's URL with its cookie; the apps
 * cannot send their token with an `<img>`, so they use the user's signed icon path instead.
 */
export function iconSrc(
  subscription: Pick<Subscription, 'id' | 'iconUrl'>,
  iconsPath: string | undefined,
  server: string | null,
): string | null {
  if (!subscription.iconUrl) return null;
  if (!server) return subscription.iconUrl;
  return iconsPath ? absolute(`${iconsPath}/${String(subscription.id)}.ico`, server) : null;
}

const URL_ATTRIBUTES = ['src', 'href', 'poster'];

/** Entry HTML with server-relative links and media sources (image proxy) made absolute. */
export function resolveContentUrls(html: string, server: string | null): string {
  if (!server) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const element of doc.body.querySelectorAll('[src], [href], [poster], [srcset]')) {
    for (const name of URL_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value && serverRelative(value)) element.setAttribute(name, absolute(value, server));
    }
    const srcset = element.getAttribute('srcset');
    if (srcset) {
      element.setAttribute(
        'srcset',
        srcset
          .split(',')
          .map((candidate) => {
            const [url = '', ...descriptor] = candidate.trim().split(/\s+/);
            return [absolute(url, server), ...descriptor].join(' ');
          })
          .join(', '),
      );
    }
  }
  return doc.body.innerHTML;
}
