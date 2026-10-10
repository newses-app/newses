import { serverOrigin } from '../platform/index.ts';

/** Public pages are on the server's origin (Docker and CloudFront both route `/public`). */
export const shareUrl = (shareId: string) => `${serverOrigin()}/public/share/${shareId}`;
export const publishedFeedUrl = (key: string) =>
  `${serverOrigin()}/public/feeds/${encodeURIComponent(key)}`;
