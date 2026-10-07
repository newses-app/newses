/** Public URLs are on the same origin as the app (Docker and CloudFront both route `/public`). */
export const shareUrl = (shareId: string) => `${location.origin}/public/share/${shareId}`;
export const publishedFeedUrl = (key: string) =>
  `${location.origin}/public/feeds/${encodeURIComponent(key)}`;
