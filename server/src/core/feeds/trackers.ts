/** Hosts whose images in feed content only count reads; matched with their subdomains. */
const TRACKER_HOSTS = [
  'feeds.feedburner.com',
  'feedproxy.google.com',
  'pixel.wp.com',
  'stats.wordpress.com',
  'google-analytics.com',
  'doubleclick.net',
  'scorecardresearch.com',
  'quantserve.com',
  'pixel.facebook.com',
  'ct.pinterest.com',
  'analytics.twitter.com',
  'pixel.mathtag.com',
  'feeds.wordpress.com',
];

const tiny = (value: string | undefined) => value !== undefined && /^\s*[01](px)?\s*$/i.test(value);

/** True for 1×1 images and images from known tracking hosts. */
export function isTrackingPixel(attribs: Record<string, string>): boolean {
  if (tiny(attribs.width) && tiny(attribs.height)) return true;
  let host: string;
  try {
    host = new URL(attribs.src ?? '').hostname.toLowerCase();
  } catch {
    return false;
  }
  return TRACKER_HOSTS.some((tracker) => host === tracker || host.endsWith(`.${tracker}`));
}
