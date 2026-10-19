import {
  type Entry,
  MAX_PAGE_TEXT_LENGTH,
  MAX_PAGE_TITLE_LENGTH,
  normaliseTag,
  type Stream,
} from '@newses/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { EntryServices } from '../../core/entries/index.ts';
import type { LabelRow } from '../../core/entries/labels.ts';
import { textOfHtml } from '../../core/entries/text.ts';
import { DomainError, ThrottledError } from '../../core/errors.ts';
import type { FeedServices } from '../../core/feeds/index.ts';
import type { SubscriptionView } from '../../core/feeds/subscriptions.ts';
import type { PrefsService } from '../../core/prefs.ts';
import { ICONS_PATH, sendIcon } from '../icons.ts';
import { logUnsupported } from './common.ts';
import {
  sessionOf,
  stringParam,
  type TtrssContext,
  TtrssError,
  type TtrssOps,
  type TtrssParams,
} from './ttrss.ts';

export interface TtrssDeps {
  entries: EntryServices;
  feeds: FeedServices;
  prefs: PrefsService;
}

/** Labels appear as feeds with ids below this: label 1 is feed -1026. */
const LABEL_BASE = -1025;
export const labelFeedId = (labelId: number) => LABEL_BASE - labelId;
const labelIdOf = (feedId: number) => (feedId <= LABEL_BASE - 1 ? LABEL_BASE - feedId : null);

/** TTRSS's virtual feeds, as listed under the Special category (-1). */
const SPECIAL_FEEDS = [
  { id: -4, title: 'All articles' },
  { id: -3, title: 'Fresh articles' },
  { id: -1, title: 'Starred articles' },
  { id: -2, title: 'Published articles' },
  { id: 0, title: 'Archived articles' },
  { id: -6, title: 'Recently read' },
] as const;

const MAX_HEADLINES = 200;

/** subscribeToFeed status codes: 0 already subscribed, 1 added, 2 invalid URL, 3 no feed found, 4 several feeds found, 5 fetch failed. */
const SUBSCRIBE_CODES: Partial<Record<DomainError['code'], number>> = {
  conflict: 0,
  invalid_input: 2,
  feed_not_found: 3,
  fetch_failed: 5,
  throttled: 5,
};

// Clients send numbers and booleans as JSON values or as strings.
function intParam(params: TtrssParams, name: string): number | undefined {
  const value = params[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
  return undefined;
}

function boolParam(params: TtrssParams, name: string, fallback = false): boolean {
  const value = params[name];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['true', 't', '1', 'yes'].includes(value.toLowerCase());
  return fallback;
}

/** A comma-separated or array list of ids. */
function idsParam(params: TtrssParams, name: string): number[] {
  const value = params[name];
  const items: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [value];
  return items
    .map((item) => (typeof item === 'string' ? Number(item.trim()) : item))
    .filter((item): item is number => Number.isSafeInteger(item));
}

const unix = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : 0);

/**
 * The stream a TTRSS feed or category id selects; null for the Archived feed, which holds nothing
 * until archived feeds exist. String ids name tags (API level 18).
 */
function streamFor(feedId: unknown, isCat: boolean): Stream | null {
  if (typeof feedId === 'string' && !/^-?\d+$/.test(feedId.trim())) {
    const tag = normaliseTag(feedId);
    return tag ? { tag } : null;
  }
  const id = Number(feedId ?? 0);
  if (isCat) return id >= 0 ? { categoryId: id } : {};
  if (id > 0) return { subscriptionId: id };
  const label = labelIdOf(id);
  if (label !== null) return { labelId: label };
  switch (id) {
    case -1:
      return { special: 'starred' };
    case -2:
      return { special: 'published' };
    case -3:
      return { special: 'fresh' };
    case -4:
      return { special: 'all' };
    case -6:
      return { special: 'recentlyRead' };
    default:
      return null;
  }
}

function feedOf(view: SubscriptionView, unread: number) {
  const { subscription, source } = view;
  return {
    feed_url: source.url,
    title: subscription.title ?? source.title ?? source.url,
    id: subscription.id,
    unread,
    has_icon: source.faviconKey !== null,
    cat_id: subscription.categoryId ?? 0,
    last_updated: unix(source.lastFetchedAt?.toISOString()),
    order_id: subscription.sortOrder,
  };
}

export function ttrssOps({ entries: entryServices, feeds, prefs }: TtrssDeps): TtrssOps {
  const { entries, counters, labels: labelService } = entryServices;

  async function labelsById(userId: number) {
    return new Map((await labelService.list(userId)).map((label) => [label.id, label]));
  }

  /**
   * Content for clients: the full text for subscriptions opted in to it, with images pointed at
   * the proxy for users who turned it on.
   */
  async function proxied(userId: number, given: Entry[]): Promise<Entry[]> {
    let list = given;
    if (list.some((e) => e.fullContent)) {
      const opted = new Set(
        (await feeds.subscriptions.list(userId))
          .filter((v) => v.subscription.fullText)
          .map((v) => v.subscription.id),
      );
      list = list.map((e) =>
        e.fullContent && e.subscriptionId !== null && opted.has(e.subscriptionId)
          ? { ...e, content: e.fullContent }
          : e,
      );
    }
    if (!list.some((e) => e.content) || !(await prefs.get(userId)).proxyImages) return list;
    return list.map((e) => (e.content ? { ...e, content: feeds.images.rewrite(e.content) } : e));
  }

  function article(entry: Entry, labels: Map<number, LabelRow>) {
    return {
      id: entry.id,
      guid: String(entry.id),
      unread: entry.unread,
      marked: entry.starred,
      published: entry.published,
      updated: unix(entry.publishedAt ?? entry.sortAt),
      is_updated: false,
      title: entry.title ?? '',
      link: entry.link ?? '',
      feed_id: entry.subscriptionId ?? 0,
      feed_title: entry.feedTitle ?? '',
      tags: entry.tags,
      labels: entry.labels.flatMap((id) => {
        const label = labels.get(id);
        return label ? [[labelFeedId(id), label.caption, label.fgColor, label.bgColor]] : [];
      }),
      author: entry.author ?? '',
      score: entry.score,
      note: entry.note,
      lang: '',
      comments_count: 0,
      comments_link: '',
      always_display_attachments: false,
      flavor_image: '',
      flavor_stream: '',
    };
  }

  const attachments = (entry: Entry) =>
    (entry.enclosures ?? []).map((enclosure, index) => ({
      id: index + 1,
      post_id: entry.id,
      content_url: enclosure.url,
      content_type: enclosure.mimeType ?? '',
      title: '',
      duration: enclosure.durationSeconds === null ? '' : String(enclosure.durationSeconds),
      width: enclosure.width ?? 0,
      height: enclosure.height ?? 0,
    }));

  const config = ttrssConfig({ feeds });

  /** Feeds, labels, and special feeds with their unread counts. */
  async function overview(userId: number) {
    const [subscriptions, categories, labels, count] = await Promise.all([
      feeds.subscriptions.list(userId),
      feeds.categories.list(userId),
      labelService.list(userId),
      counters.get(userId),
    ]);
    const unreadOf = (list: { id: number; unread: number }[]) =>
      new Map(list.map((item) => [item.id, item.unread]));
    const bySubscription = unreadOf(count.subscriptions);
    const byCategory = unreadOf(count.categories);
    const byLabel = unreadOf(count.labels);
    const special = new Map<number, number>([
      [-4, count.special.all],
      [-3, count.special.fresh],
      [-1, count.special.starred],
      [-2, count.special.published],
      [0, 0],
      [-6, 0],
    ]);
    return {
      subscriptions,
      categories,
      labels,
      count,
      feedUnread: (id: number) => bySubscription.get(id) ?? 0,
      categoryUnread: (id: number) => byCategory.get(id) ?? 0,
      labelUnread: (id: number) => byLabel.get(id) ?? 0,
      specialUnread: (id: number) => special.get(id) ?? 0,
    };
  }

  const userOf = (context: TtrssContext) => sessionOf(context).user.id;

  async function setLabel(userId: number, ids: number[], labelId: number, assign: boolean) {
    let updated = 0;
    for (const id of ids) {
      let entry;
      try {
        entry = await entries.get(userId, id);
      } catch (err) {
        if (err instanceof DomainError && err.code === 'not_found') continue;
        throw err;
      }
      const has = entry.labels.includes(labelId);
      if (has === assign) continue;
      await labelService.setEntryLabels(
        userId,
        id,
        assign ? [...entry.labels, labelId] : entry.labels.filter((l) => l !== labelId),
      );
      updated++;
    }
    return updated;
  }

  return {
    getConfig: { run: (context) => config(userOf(context)) },

    getUnread: {
      async run(context) {
        return { unread: (await counters.get(userOf(context))).special.all };
      },
    },

    getCounters: {
      async run(context) {
        const userId = userOf(context);
        const mode = stringParam(context.params, 'output_mode') ?? 'flc';
        const o = await overview(userId);
        const items: Record<string, unknown>[] = [
          { id: 'global-unread', counter: o.count.special.all },
          { id: 'subscribed-feeds', counter: o.subscriptions.length },
        ];
        if (mode.includes('f')) {
          for (const { id } of SPECIAL_FEEDS)
            items.push({ id, counter: o.specialUnread(id), auxcounter: 0 });
          for (const view of o.subscriptions)
            items.push({
              id: view.subscription.id,
              counter: o.feedUnread(view.subscription.id),
              has_img: view.source.faviconKey !== null ? 1 : 0,
              updated: view.source.lastFetchedAt?.toISOString() ?? '',
              ...(view.source.lastError && { error: view.source.lastError }),
            });
        }
        if (mode.includes('l'))
          for (const label of o.labels)
            items.push({
              id: labelFeedId(label.id),
              counter: o.labelUnread(label.id),
              auxcounter: 0,
            });
        if (mode.includes('c')) {
          items.push({ id: 0, kind: 'cat', counter: o.categoryUnread(0) });
          for (const category of o.categories)
            items.push({ id: category.id, kind: 'cat', counter: o.categoryUnread(category.id) });
        }
        return items;
      },
    },

    getFeeds: {
      async run(context) {
        const { params } = context;
        const catId = intParam(params, 'cat_id') ?? 0;
        const o = await overview(userOf(context));
        const special = () =>
          SPECIAL_FEEDS.map(({ id, title }) => ({
            id,
            title,
            unread: o.specialUnread(id),
            cat_id: -1,
          }));
        const labels = () =>
          o.labels.map((label) => ({
            id: labelFeedId(label.id),
            title: label.caption,
            unread: o.labelUnread(label.id),
            cat_id: -2,
          }));
        const real = (filter: (view: SubscriptionView) => boolean) =>
          o.subscriptions
            .filter(filter)
            .map((view) => feedOf(view, o.feedUnread(view.subscription.id)));
        let list: { unread: number }[];
        if (catId === -1) list = special();
        else if (catId === -2) list = labels();
        else if (catId === -3) list = real(() => true);
        else if (catId === -4) list = [...special(), ...labels(), ...real(() => true)];
        else {
          const children = boolParam(params, 'include_nested')
            ? o.categories
                .filter((c) => (c.parentId ?? 0) === catId && catId > 0)
                .map((c) => ({
                  id: c.id,
                  title: c.title,
                  unread: o.categoryUnread(c.id),
                  is_cat: true,
                  order_id: c.sortOrder,
                }))
            : [];
          list = [...children, ...real((v) => (v.subscription.categoryId ?? 0) === catId)];
        }
        if (boolParam(params, 'unread_only')) list = list.filter((item) => item.unread > 0);
        const offset = Math.max(intParam(params, 'offset') ?? 0, 0);
        const limit = intParam(params, 'limit') ?? 0;
        return list.slice(offset, limit > 0 ? offset + limit : undefined);
      },
    },

    getCategories: {
      async run(context) {
        const { params } = context;
        const o = await overview(userOf(context));
        const nested = boolParam(params, 'enable_nested');
        const includeEmpty = boolParam(params, 'include_empty');
        // A category counts as having feeds when it or a subcategory holds one.
        const parents = new Map(o.categories.map((c) => [c.id, c.parentId]));
        const withFeeds = new Set<number>();
        for (const view of o.subscriptions) {
          const seen = new Set<number>();
          for (let id = view.subscription.categoryId; id != null && !seen.has(id);) {
            seen.add(id);
            withFeeds.add(id);
            id = parents.get(id) ?? null;
          }
        }
        let list = o.categories
          .filter((c) => !nested || c.parentId === null)
          .filter((c) => includeEmpty || withFeeds.has(c.id))
          .map((c) => ({
            id: c.id,
            title: c.title,
            unread: o.categoryUnread(c.id),
            order_id: c.sortOrder,
          }));
        const uncategorised = o.subscriptions.some((v) => v.subscription.categoryId === null);
        if (uncategorised || includeEmpty)
          list.push({ id: 0, title: 'Uncategorized', unread: o.categoryUnread(0), order_id: 0 });
        list.push({ id: -1, title: 'Special', unread: o.count.special.fresh, order_id: 0 });
        if (o.labels.length > 0 || includeEmpty)
          list.push({
            id: -2,
            title: 'Labels',
            unread: o.count.labels.reduce((sum, l) => sum + l.unread, 0),
            order_id: 0,
          });
        if (boolParam(params, 'unread_only')) list = list.filter((c) => c.unread > 0);
        return list;
      },
    },

    getFeedTree: {
      async run(context) {
        const o = await overview(userOf(context));
        const includeEmpty = boolParam(context.params, 'include_empty');
        const feedNode = (view: SubscriptionView) => ({
          id: `FEED:${String(view.subscription.id)}`,
          bare_id: view.subscription.id,
          name: view.subscription.title ?? view.source.title ?? view.source.url,
          type: 'feed',
          unread: o.feedUnread(view.subscription.id),
          error: view.source.lastError ?? '',
          updated: view.source.lastFetchedAt?.toISOString() ?? '',
          checkbox: false,
          auxcounter: 0,
          param: '',
        });
        const categoryNode = (id: number, name: string, items: unknown[]) => ({
          id: `CAT:${String(id)}`,
          bare_id: id,
          name,
          type: 'category',
          unread: id >= 0 ? o.categoryUnread(id) : 0,
          items,
          checkbox: false,
          auxcounter: 0,
          param: `(${String(items.length)})`,
        });
        const tree = (parentId: number | null): unknown[] => [
          ...o.categories
            .filter((c) => c.parentId === parentId)
            .map((c) => categoryNode(c.id, c.title, tree(c.id)))
            .filter((node) => includeEmpty || node.items.length > 0),
          ...(parentId === null
            ? []
            : o.subscriptions.filter((v) => v.subscription.categoryId === parentId).map(feedNode)),
        ];
        const special = categoryNode(
          -1,
          'Special',
          SPECIAL_FEEDS.map(({ id, title }) => ({
            id: `FEED:${String(id)}`,
            bare_id: id,
            name: title,
            type: 'feed',
            unread: o.specialUnread(id),
            checkbox: false,
            auxcounter: 0,
          })),
        );
        const labels = categoryNode(
          -2,
          'Labels',
          o.labels.map((label) => ({
            id: `FEED:${String(labelFeedId(label.id))}`,
            bare_id: labelFeedId(label.id),
            name: label.caption,
            type: 'feed',
            unread: o.labelUnread(label.id),
            fg_color: label.fgColor,
            bg_color: label.bgColor,
            checkbox: false,
            auxcounter: 0,
          })),
        );
        const uncategorised = categoryNode(
          0,
          'Uncategorized',
          o.subscriptions.filter((v) => v.subscription.categoryId === null).map(feedNode),
        );
        const items = [
          special,
          ...(o.labels.length > 0 ? [labels] : []),
          ...tree(null),
          ...(includeEmpty || uncategorised.items.length > 0 ? [uncategorised] : []),
        ];
        return { categories: { identifier: 'id', label: 'name', items } };
      },
    },

    getHeadlines: {
      async run(context) {
        const { params } = context;
        const userId = userOf(context);
        const isCat = boolParam(params, 'is_cat');
        const feedId = params.feed_id;
        const search = stringParam(params, 'search')?.trim();
        const stream =
          search && stringParam(params, 'search_mode') === 'all_feeds'
            ? {}
            : streamFor(feedId, isCat);
        const viewMode = stringParam(params, 'view_mode') ?? 'all_articles';
        const showContent = boolParam(params, 'show_content');
        const showExcerpt = boolParam(params, 'show_excerpt');
        const withAttachments = boolParam(params, 'include_attachments');
        const limit = Math.min(Math.max(intParam(params, 'limit') ?? 60, 1), MAX_HEADLINES);
        const page = stream
          ? await entries.list(userId, {
              stream,
              view: viewMode === 'unread' ? 'unread' : viewMode === 'adaptive' ? 'adaptive' : 'all',
              flags: viewMode === 'marked' ? { starred: true } : undefined,
              ...(search
                ? { q: search }
                : {
                    order: stringParam(params, 'order_by') === 'date_reverse' ? 'oldest' : 'newest',
                  }),
              offset: Math.max(intParam(params, 'skip') ?? 0, 0),
              sinceId: intParam(params, 'since_id'),
              limit,
              content: showContent,
              enclosures: withAttachments,
            })
          : { entries: [] };
        const labels = await labelsById(userId);
        const headlines = (await proxied(userId, page.entries)).map((entry) => ({
          ...article(entry, labels),
          ...(showExcerpt && { excerpt: entry.excerpt ?? '' }),
          ...(showContent && { content: entry.content ?? '' }),
          ...(withAttachments && { attachments: attachments(entry) }),
        }));
        if (!boolParam(params, 'include_header')) return headlines;
        return [{ id: feedId ?? 0, is_cat: isCat, first_id: headlines[0]?.id ?? 0 }, headlines];
      },
    },

    getArticle: {
      async run(context) {
        const userId = userOf(context);
        const found: Entry[] = [];
        for (const id of idsParam(context.params, 'article_id')) {
          try {
            found.push(await entries.get(userId, id));
          } catch (err) {
            if (!(err instanceof DomainError && err.code === 'not_found')) throw err;
          }
        }
        const labels = await labelsById(userId);
        return (await proxied(userId, found)).map((entry) => ({
          ...article(entry, labels),
          comments: '',
          content: entry.content ?? '',
          attachments: attachments(entry),
        }));
      },
    },

    updateArticle: {
      async run(context) {
        const { params } = context;
        const userId = userOf(context);
        const ids = idsParam(params, 'article_ids');
        const mode = intParam(params, 'mode') ?? 0;
        const field = intParam(params, 'field') ?? 0;
        if (field === 3) {
          for (const id of ids)
            await entries.setNote(userId, id, stringParam(params, 'data') ?? null);
          return { status: 'OK', updated: ids.length };
        }
        const flag = (['starred', 'published', 'unread'] as const)[field];
        if (!flag || mode < 0 || mode > 2) throw new TtrssError('INCORRECT_USAGE');
        const value = mode === 1;
        const updated =
          mode === 2
            ? await entries.toggle(userId, ids, flag)
            : await entries.setState(
                userId,
                ids,
                flag === 'starred'
                  ? { starred: value }
                  : flag === 'published'
                    ? { published: value }
                    : { unread: value },
              );
        return { status: 'OK', updated };
      },
    },

    shareToPublished: {
      async run(context) {
        const { params } = context;
        const url = stringParam(params, 'url')?.trim();
        if (!url) throw new TtrssError('INCORRECT_USAGE');
        // TTRSS strips tags from the title and content; values too long are cut, not refused.
        const title = textOfHtml(stringParam(params, 'title') ?? '');
        const text = textOfHtml(stringParam(params, 'content') ?? '');
        await feeds.publishedPages.publish(userOf(context), {
          url,
          title: title?.slice(0, MAX_PAGE_TITLE_LENGTH) ?? null,
          text: text?.slice(0, MAX_PAGE_TEXT_LENGTH) ?? null,
        });
        return { status: 'OK' };
      },
    },

    catchupFeed: {
      async run(context) {
        const { params } = context;
        const stream = streamFor(params.feed_id, boolParam(params, 'is_cat'));
        const days = { '1day': 1, '1week': 7, '2week': 14 }[stringParam(params, 'mode') ?? 'all'];
        if (stream) await entries.markRead(userOf(context), stream, { olderThanDays: days });
        return { status: 'OK' };
      },
    },

    updateFeed: {
      async run(context) {
        const feedId = intParam(context.params, 'feed_id');
        if (feedId === undefined) throw new TtrssError('INCORRECT_USAGE');
        try {
          await feeds.updater.refresh(userOf(context), feedId);
        } catch (err) {
          // The feed's host asked for a pause; it is fetched once that ends.
          if (!(err instanceof ThrottledError)) throw err;
        }
        return { status: 'OK' };
      },
    },

    getPref: {
      async run(context) {
        const name = stringParam(context.params, 'pref_name') ?? '';
        const p = await prefs.get(userOf(context));
        const values: Record<string, unknown> = {
          ENABLE_API_ACCESS: true,
          ENABLE_FEED_CATS: true,
          FRESH_ARTICLE_MAX_AGE: p.freshMaxAgeHours,
          HIDE_READ_FEEDS: p.hideReadFeeds,
          COMBINED_DISPLAY_MODE: p.layout === 'combined',
          CDM_AUTO_CATCHUP: p.markReadOnScroll,
          CONFIRM_FEED_CATCHUP: p.confirmCatchUp,
          PURGE_OLD_DAYS: p.purgeDays,
          ON_CATCHUP_SHOW_NEXT_FEED: false,
        };
        if (!Object.hasOwn(values, name)) {
          logUnsupported(context.request, 'ttrss', `getPref ${name}`);
          return { value: null };
        }
        return { value: values[name] };
      },
    },

    getLabels: {
      async run(context) {
        const userId = userOf(context);
        const articleId = intParam(context.params, 'article_id');
        const assigned =
          articleId === undefined ? [] : (await entries.get(userId, articleId)).labels;
        return (await labelService.list(userId)).map((label) => ({
          id: labelFeedId(label.id),
          caption: label.caption,
          fg_color: label.fgColor,
          bg_color: label.bgColor,
          checked: assigned.includes(label.id),
        }));
      },
    },

    setArticleLabel: {
      async run(context) {
        const { params } = context;
        const given = intParam(params, 'label_id');
        const labelId = given === undefined ? null : (labelIdOf(given) ?? given);
        if (labelId === null || labelId <= 0) throw new TtrssError('INCORRECT_USAGE');
        const updated = await setLabel(
          userOf(context),
          idsParam(params, 'article_ids'),
          labelId,
          boolParam(params, 'assign'),
        );
        return { status: 'OK', updated };
      },
    },

    subscribeToFeed: {
      async run(context) {
        const { params } = context;
        const url = stringParam(params, 'feed_url')?.trim();
        if (!url) return { status: { code: 2 } };
        const categoryId = intParam(params, 'category_id') ?? 0;
        try {
          const result = await feeds.subscriptions.subscribe(
            userOf(context),
            url,
            categoryId > 0 ? categoryId : null,
          );
          if (result.status === 'choose')
            return {
              status: {
                code: 4,
                feeds: Object.fromEntries(result.candidates.map((c) => [c.url, c.title ?? c.url])),
              },
            };
          return { status: { code: 1, feed_id: result.subscription.subscription.id } };
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
          const code = SUBSCRIBE_CODES[err.code];
          if (code === undefined) throw err;
          return { status: { code, message: err.message } };
        }
      },
    },

    unsubscribeFeed: {
      async run(context) {
        const feedId = intParam(context.params, 'feed_id');
        try {
          if (feedId === undefined) throw new DomainError('not_found', 'No feed');
          await feeds.subscriptions.unsubscribe(userOf(context), feedId);
        } catch (err) {
          if (err instanceof DomainError && err.code === 'not_found')
            throw new TtrssError('FEED_NOT_FOUND');
          throw err;
        }
        return { status: 'OK' };
      },
    },
  };
}

/** `getConfig`, which `login` also returns as `config` (API level 17). */
export function ttrssConfig({ feeds }: Pick<TtrssDeps, 'feeds'>) {
  return async (userId: number) => ({
    icons_dir: ICONS_PATH,
    icons_url: `${ICONS_PATH}/${feeds.iconTokens.issue(userId)}`,
    daemon_is_running: true,
    num_feeds: (await feeds.subscriptions.list(userId)).length,
    custom_sort_types: {},
  });
}

/**
 * Feed icons at the path `getConfig` gives clients: `/feed-icons/<user segment>/<feed id>.ico`.
 * Clients send no credentials for icons, so the signed segment stands in for them.
 */
export const feedIconRoutes: FastifyPluginAsync<Pick<TtrssDeps, 'feeds'>> = (app, { feeds }) => {
  app.get<{ Params: { token: string; file: string } }>(
    `/${ICONS_PATH}/:token/:file`,
    { config: { logSecrets: ['token'] } },
    async (request, reply) => {
      const userId = feeds.iconTokens.userOf(request.params.token);
      const id = /^(\d+)\.ico$/.exec(request.params.file)?.[1];
      const view =
        userId === null || !id
          ? null
          : await feeds.subscriptions.get(userId, Number(id)).catch(() => null);
      const icon =
        view && userId !== null ? await feeds.favicons.getForUser(userId, view.source.id) : null;
      if (!icon) return reply.code(404).type('text/plain').send('Not found\n');
      return sendIcon(reply, icon);
    },
  );
  return Promise.resolve();
};
