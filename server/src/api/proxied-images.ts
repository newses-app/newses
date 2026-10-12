import type { ImageProxy } from '../core/feeds/images.ts';
import type { PrefsService } from '../core/prefs.ts';

/** Points images in entries' content at the proxy, for users who turned it on. */
export function proxiedImages(prefs: PrefsService, images: ImageProxy) {
  return async function withImages<
    T extends { content?: string | null | undefined; fullContent?: string | null | undefined },
  >(userId: number, list: T[]): Promise<T[]> {
    if (!list.some((e) => e.content || e.fullContent) || !(await prefs.get(userId)).proxyImages)
      return list;
    return list.map((e) => ({
      ...e,
      ...(e.content && { content: images.rewrite(e.content) }),
      ...(e.fullContent && { fullContent: images.rewrite(e.fullContent) }),
    }));
  };
}
