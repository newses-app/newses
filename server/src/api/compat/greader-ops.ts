import type { Entry, Stream } from '@rss-reader/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import type { CategoryRow } from '../../core/categories.ts';
import type { EntryFlags } from '../../core/entries/entries.ts';
import type { EntryServices } from '../../core/entries/index.ts';
import type { LabelRow } from '../../core/entries/labels.ts';
import { DomainError } from '../../core/errors.ts';
import type { FeedServices } from '../../core/feeds/index.ts';
import type { SubscriptionView } from '../../core/feeds/subscriptions.ts';
import { normalizeFeedUrl } from '../../core/feeds/url.ts';
import type { PrefsService } from '../../core/prefs.ts';
import { logUnsupported } from './common.ts';
import { readerParams, readerSession } from './greader.ts';

export interface GreaderDeps {
  entries: EntryServices;
  feeds: FeedServices;
  prefs: PrefsService;
  /** Origin of icon URLs; null uses each request's origin. */
  publicUrl: string | null;
}

const STATE = 'user/-/state/com.google/';
const READING_LIST = `${STATE}reading-list`;
const READ = `${STATE}read`;
const STARRED = `${STATE}starred`;
const KEPT_UNREAD = `${STATE}kept-unread`;
const BROADCAST = `${STATE}broadcast`;
const LABEL = 'user/-/label/';
const ITEM_PREFIX = 'tag:google.com,2005:reader/item/';

/** Page sizes: `n` defaults and caps for content and for id lists. */
const CONTENTS_DEFAULT = 20;
const CONTENTS_MAX = 1000;
const IDS_DEFAULT = 1000;
const IDS_MAX = 10_000;
/** Items fetched by id in one call. */
const ITEMS_MAX = 1000;
/** Colours of labels created by tagging items: the web app's first label colour. */
const NEW_LABEL = { fgColor: '#ffffff', bgColor: '#1565c0' };

/** Long-form item id: the `user_entries` id as 16 hex digits. */
export const longItemId = (id: number) => `${ITEM_PREFIX}${id.toString(16).padStart(16, '0')}`;

/** An item id in long form, bare 16-digit hex, or decimal short form. */
export function parseItemId(value: string): number | null {
  const trimmed = value.trim();
  const hex =
    (trimmed.startsWith(ITEM_PREFIX) ? trimmed.slice(ITEM_PREFIX.length) : null) ??
    (/^[0-9a-f]{16}$/i.test(trimmed) ? trimmed : null);
  const id =
    hex !== null
      ? /^[0-9a-f]{1,16}$/i.test(hex)
        ? Number.parseInt(hex, 16)
        : Number.NaN
      : /^\d+$/.test(trimmed)
        ? Number(trimmed)
        : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const safeNormalise = (url: string) => {
  try {
    return normalizeFeedUrl(url);
  } catch {
    return url;
  }
};

/** `user/<id>/…` names the caller as `user/-/…` does. */
const normaliseStreamId = (id: string) => id.trim().replace(/^user\/[^/]+\//, 'user/-/');

function intParam(params: URLSearchParams, name: string): number | undefined {
  const value = params.get(name)?.trim();
  return value && /^-?\d+$/.test(value) ? Number(value) : undefined;
}

const pageSize = (params: URLSearchParams, fallback: number, max: number) =>
  Math.min(Math.max(intParam(params, 'n') ?? fallback, 1), max);

/** Seconds since the epoch, as `ot`/`nt` send them. */
function timeParam(params: URLSearchParams, name: string): Date | undefined {
  const seconds = intParam(params, name);
  return seconds === undefined || seconds <= 0 ? undefined : new Date(seconds * 1000);
}

const ok = (reply: FastifyReply) => reply.type('text/plain; charset=utf-8').send('OK');
const fail = (reply: FastifyReply, status: number, message: string) =>
  reply.code(status).type('text/plain; charset=utf-8').send(`${message}\n`);

/** A user's folders and labels by Google Reader name. */
interface Names {
  categories: CategoryRow[];
  labels: LabelRow[];
  /** Folder name: nested categories flatten to `Parent/Child`. */
  folderName: (categoryId: number) => string;
  folderNamed: (name: string) => CategoryRow | undefined;
  /** Labels whose name no folder takes. */
  visibleLabels: LabelRow[];
  labelNamed: (name: string) => LabelRow | undefined;
}

/** A stream as `entries.list` takes it, with Google Reader's state filters. */
interface Resolved {
  stream: Stream;
  flags: EntryFlags;
}

/**
 * Google Reader API endpoints over the core services: folders are categories, tags are labels,
 * item ids are `user_entries` ids, and streams map to the native API's streams.
 */
export function greaderEndpoints({ entries: entryServices, feeds, prefs, publicUrl }: GreaderDeps) {
  const { entries, counters, labels: labelService } = entryServices;

  async function names(userId: number): Promise<Names> {
    const [categories, labels] = await Promise.all([
      feeds.categories.list(userId),
      labelService.list(userId),
    ]);
    const byId = new Map(categories.map((c) => [c.id, c]));
    const folderName = (id: number) => {
      const parts: string[] = [];
      const seen = new Set<number>();
      for (let c = byId.get(id); c && !seen.has(c.id); c = byId.get(c.parentId ?? -1)) {
        seen.add(c.id);
        parts.unshift(c.title);
      }
      return parts.join('/');
    };
    const folders = new Map(categories.map((c) => [folderName(c.id), c]));
    const visibleLabels = labels.filter((l) => !folders.has(l.caption));
    return {
      categories,
      labels,
      folderName,
      folderNamed: (name) => folders.get(name),
      visibleLabels,
      labelNamed: (name) =>
        visibleLabels.find((l) => l.caption === name) ??
        visibleLabels.find((l) => l.caption.toLowerCase() === name.toLowerCase()),
    };
  }

  const subscriptionOf = (views: SubscriptionView[], streamId: string) => {
    const ref = streamId.slice('feed/'.length);
    return /^\d+$/.test(ref)
      ? views.find((v) => v.subscription.id === Number(ref))
      : views.find((v) => v.source.url === ref);
  };

  /** The stream a Google Reader stream id names; null when it names nothing of the user's. */
  async function resolve(userId: number, streamId: string): Promise<Resolved | null> {
    const id = normaliseStreamId(streamId);
    switch (id) {
      case READING_LIST:
        return { stream: { special: 'all' }, flags: {} };
      case STARRED:
        return { stream: { special: 'starred' }, flags: {} };
      case READ:
        return { stream: { special: 'all' }, flags: { unread: false } };
      case BROADCAST:
        return { stream: { special: 'published' }, flags: {} };
    }
    if (id.startsWith(LABEL)) {
      const n = await names(userId);
      const name = id.slice(LABEL.length);
      const folder = n.folderNamed(name);
      if (folder) return { stream: { categoryId: folder.id }, flags: {} };
      const label = n.labelNamed(name);
      return label ? { stream: { labelId: label.id }, flags: {} } : null;
    }
    if (id.startsWith('feed/')) {
      const view = subscriptionOf(await feeds.subscriptions.list(userId), id);
      return view ? { stream: { subscriptionId: view.subscription.id }, flags: {} } : null;
    }
    return null;
  }

  /** Applies `it` (include) and `xt` (exclude) state targets to `flags`. */
  function targets(request: FastifyRequest, params: URLSearchParams, flags: EntryFlags) {
    const result = { ...flags };
    for (const [name, include] of [
      ['it', true],
      ['xt', false],
    ] as const)
      for (const target of params.getAll(name).map(normaliseStreamId)) {
        if (target === READ) result.unread = !include;
        else if (target === STARRED) result.starred = include;
        else if (target === KEPT_UNREAD) result.unread = include;
        else if (!(include && target === READING_LIST))
          logUnsupported(request, 'greader', `${name}=${target}`);
      }
    return result;
  }

  /** The stream id from the path (`stream/contents/<id>`) or `s`. */
  function streamIdOf(request: FastifyRequest, params: URLSearchParams) {
    const path = (request.params as { '*'?: string })['*'];
    return path || params.get('s') || READING_LIST;
  }

  function origin(request: FastifyRequest) {
    return publicUrl ?? `${request.protocol}://${request.host}`;
  }

  /** Builds items for `list`, with their folders, labels, and origins. */
  async function itemsOf(userId: number, list: Entry[]) {
    const [views, n, p] = await Promise.all([
      feeds.subscriptions.list(userId),
      names(userId),
      prefs.get(userId),
    ]);
    const bySubscription = new Map(views.map((v) => [v.subscription.id, v]));
    const labelsById = new Map(n.labels.map((l) => [l.id, l]));
    return list.map((entry) => {
      const view =
        entry.subscriptionId === null ? undefined : bySubscription.get(entry.subscriptionId);
      const categories = [READING_LIST];
      if (!entry.unread) categories.push(READ);
      if (entry.starred) categories.push(STARRED);
      if (entry.published) categories.push(BROADCAST);
      if (view?.subscription.categoryId != null)
        categories.push(`${LABEL}${n.folderName(view.subscription.categoryId)}`);
      for (const id of entry.labels) {
        const label = labelsById.get(id);
        if (label && n.visibleLabels.includes(label)) categories.push(`${LABEL}${label.caption}`);
      }
      const sortMs = Date.parse(entry.sortAt);
      const published = Math.floor(Date.parse(entry.publishedAt ?? entry.sortAt) / 1000);
      // Subscriptions opted in to full text get it once extracted.
      const content =
        (view?.subscription.fullText ? entry.fullContent : null) ?? entry.content ?? '';
      const link = entry.link ? [{ href: entry.link, type: 'text/html' }] : [];
      return {
        id: longItemId(entry.id),
        crawlTimeMsec: String(sortMs),
        timestampUsec: `${String(sortMs)}000`,
        published,
        updated: published,
        title: entry.title ?? '',
        author: entry.author ?? '',
        canonical: link,
        alternate: link,
        categories,
        origin: {
          streamId: `feed/${String(entry.subscriptionId ?? 0)}`,
          title: entry.feedTitle ?? '',
          htmlUrl: view?.source.siteUrl ?? '',
        },
        summary: {
          direction: 'ltr',
          content: p.proxyImages && content ? feeds.images.rewrite(content) : content,
        },
        enclosure: (entry.enclosures ?? []).map((e) => ({
          href: e.url,
          ...(e.mimeType && { type: e.mimeType }),
          ...(e.length !== null && { length: String(e.length) }),
        })),
      };
    });
  }

  /** Item ids from repeated `i` parameters. */
  const itemIds = (params: URLSearchParams) =>
    params
      .getAll('i')
      .map(parseItemId)
      .filter((id): id is number => id !== null);

  /** Gets or creates the label `name` for tagging items; null when a folder takes the name. */
  async function labelFor(userId: number, n: Names, name: string): Promise<LabelRow | null> {
    if (n.folderNamed(name)) return null;
    const existing = n.labelNamed(name);
    if (existing) return existing;
    const label = await labelService.create(userId, { caption: name, ...NEW_LABEL });
    n.labels.push(label);
    n.visibleLabels.push(label);
    return label;
  }

  /** The folder `name`, created at the top level when missing. */
  async function folderFor(userId: number, n: Names, name: string): Promise<CategoryRow> {
    return n.folderNamed(name) ?? feeds.categories.create(userId, name);
  }

  return (reader: FastifyInstance) => {
    const read: HTTPMethods[] = ['GET', 'POST'];

    reader.get('/user-info', (request) => {
      const { user } = readerSession(request);
      return {
        userId: String(user.id),
        userName: user.login,
        userProfileId: String(user.id),
        userEmail: '',
      };
    });

    reader.get('/subscription/list', async (request) => {
      const userId = readerSession(request).user.id;
      const [views, n] = await Promise.all([feeds.subscriptions.list(userId), names(userId)]);
      const icons = `${origin(request)}/feed-icons/${feeds.iconTokens.issue(userId)}`;
      return {
        subscriptions: views.map(({ subscription, source }) => {
          const folder =
            subscription.categoryId === null ? null : n.folderName(subscription.categoryId);
          return {
            id: `feed/${String(subscription.id)}`,
            title: subscription.title ?? source.title ?? source.url,
            categories: folder === null ? [] : [{ id: `${LABEL}${folder}`, label: folder }],
            sortid: subscription.id.toString(16).padStart(8, '0'),
            firstitemmsec: '0',
            url: source.url,
            htmlUrl: source.siteUrl ?? '',
            iconUrl: source.faviconKey ? `${icons}/${String(subscription.id)}.ico` : '',
          };
        }),
      };
    });

    reader.get('/subscription/export', async (request, reply) => {
      const opml = await feeds.opml.export(readerSession(request).user.id);
      return reply
        .type('text/x-opml; charset=utf-8')
        .header('content-disposition', 'attachment; filename="subscriptions.opml"')
        .send(opml);
    });

    reader.post('/subscription/quickadd', async (request) => {
      const userId = readerSession(request).user.id;
      const query = readerParams(request).get('quickadd')?.trim() ?? '';
      const tried = [query.replace(/^feed\//, '')];
      const found = ({ subscription, source }: SubscriptionView) => ({
        numResults: 1,
        query,
        streamId: `feed/${String(subscription.id)}`,
        streamName: subscription.title ?? source.title ?? source.url,
      });
      try {
        let result = await feeds.subscriptions.subscribe(userId, tried[0] ?? '');
        // A page advertising several feeds: take the first, as a one-step client cannot choose.
        const [first] = result.status === 'choose' ? result.candidates : [];
        if (first) {
          tried.push(first.url);
          result = await feeds.subscriptions.subscribe(userId, first.url);
        }
        if (result.status !== 'subscribed') throw new DomainError('feed_not_found', 'No feed');
        return found(result.subscription);
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        const urls = new Set(tried.flatMap((url) => [url, safeNormalise(url)]));
        const view =
          err.code === 'conflict'
            ? (await feeds.subscriptions.list(userId)).find((v) => urls.has(v.source.url))
            : undefined;
        return view ? found(view) : { numResults: 0, query, error: err.message };
      }
    });

    reader.post('/subscription/edit', async (request, reply) => {
      const userId = readerSession(request).user.id;
      const params = readerParams(request);
      const action = params.get('ac') ?? 'edit';
      const title = params.get('t')?.trim();
      const n = await names(userId);
      const addTo = params.get('a');
      const removeFrom = params.getAll('r').map(normaliseStreamId);
      const folderOf = (streamId: string | null) =>
        streamId && normaliseStreamId(streamId).startsWith(LABEL)
          ? normaliseStreamId(streamId).slice(LABEL.length)
          : null;
      const addFolder = folderOf(addTo);
      for (const streamId of params.getAll('s')) {
        if (action === 'subscribe') {
          const category = addFolder ? await folderFor(userId, n, addFolder) : null;
          let result;
          try {
            result = await feeds.subscriptions.subscribe(
              userId,
              streamId.replace(/^feed\//, ''),
              category?.id ?? null,
            );
          } catch (err) {
            if (err instanceof DomainError && err.code !== 'conflict')
              return fail(reply, 400, err.message);
            if (!(err instanceof DomainError)) throw err;
            continue;
          }
          if (result.status !== 'subscribed') return fail(reply, 400, 'Several feeds found');
          if (title)
            await feeds.subscriptions.update(userId, result.subscription.subscription.id, {
              title,
            });
          continue;
        }
        const view = subscriptionOf(await feeds.subscriptions.list(userId), streamId);
        if (!view) return fail(reply, 404, 'Subscription not found');
        const id = view.subscription.id;
        if (action === 'unsubscribe') {
          await feeds.subscriptions.unsubscribe(userId, id);
          continue;
        }
        if (action !== 'edit') return fail(reply, 400, `Unknown action ${action}`);
        const current =
          view.subscription.categoryId === null ? null : n.folderName(view.subscription.categoryId);
        const removes = removeFrom.some((r) => r === `${LABEL}${current ?? ''}`);
        const categoryId = addFolder
          ? (await folderFor(userId, n, addFolder)).id
          : removes
            ? null
            : undefined;
        await feeds.subscriptions.update(userId, id, {
          ...(title && { title }),
          ...(categoryId !== undefined && { categoryId }),
        });
      }
      return ok(reply);
    });

    reader.get('/tag/list', async (request) => {
      const n = await names(readerSession(request).user.id);
      return {
        tags: [
          { id: STARRED },
          ...n.categories
            .map((c) => n.folderName(c.id))
            .sort((a, b) => a.localeCompare(b))
            .map((name) => ({ id: `${LABEL}${name}`, type: 'folder' })),
          ...n.visibleLabels.map((l) => ({ id: `${LABEL}${l.caption}`, type: 'tag' })),
        ],
      };
    });

    reader.get('/unread-count', async (request) => {
      const userId = readerSession(request).user.id;
      const [count, newest, n] = await Promise.all([
        counters.get(userId),
        counters.newestUnread(userId),
        names(userId),
      ]);
      const newestOverall = [...newest.values()].reduce(
        (a, b) => (BigInt(b) > BigInt(a) ? b : a),
        '0',
      );
      const newestIn = (subscriptionIds: number[]) =>
        subscriptionIds
          .map((id) => newest.get(id) ?? '0')
          .reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a), '0');
      const views = await feeds.subscriptions.list(userId);
      const inFolder = (categoryId: number) => {
        const under = new Set([categoryId]);
        for (let grew = true; grew;) {
          grew = false;
          for (const c of n.categories)
            if (c.parentId !== null && under.has(c.parentId) && !under.has(c.id)) {
              under.add(c.id);
              grew = true;
            }
        }
        return views
          .filter((v) => v.subscription.categoryId !== null && under.has(v.subscription.categoryId))
          .map((v) => v.subscription.id);
      };
      const byCategory = new Map(count.categories.map((c) => [c.id, c.unread]));
      const byLabel = new Map(count.labels.map((l) => [l.id, l.unread]));
      return {
        max: count.special.all,
        unreadcounts: [
          {
            id: READING_LIST,
            count: count.special.all,
            newestItemTimestampUsec: newestOverall,
          },
          ...count.subscriptions.map((s) => ({
            id: `feed/${String(s.id)}`,
            count: s.unread,
            newestItemTimestampUsec: newest.get(s.id) ?? '0',
          })),
          ...n.categories.map((c) => ({
            id: `${LABEL}${n.folderName(c.id)}`,
            count: byCategory.get(c.id) ?? 0,
            newestItemTimestampUsec: newestIn(inFolder(c.id)),
          })),
          ...n.visibleLabels.map((l) => ({
            id: `${LABEL}${l.caption}`,
            count: byLabel.get(l.id) ?? 0,
            newestItemTimestampUsec: '0',
          })),
        ],
      };
    });

    /** `stream/contents`: items with content, `n` per page, continued by `c`. */
    const contents = async (request: FastifyRequest) => {
      const userId = readerSession(request).user.id;
      const params = readerParams(request);
      const streamId = streamIdOf(request, params);
      const resolved = await resolve(userId, streamId);
      const updated = Math.floor(Date.now() / 1000);
      if (!resolved) return { id: streamId, updated, items: [] };
      const page = await entries.list(userId, {
        stream: resolved.stream,
        view: 'all',
        order: params.get('r') === 'o' ? 'oldest' : 'newest',
        cursor: params.get('c') ?? undefined,
        limit: pageSize(params, CONTENTS_DEFAULT, CONTENTS_MAX),
        content: true,
        flags: targets(request, params, resolved.flags),
        sortedFrom: timeParam(params, 'ot'),
        sortedBefore: timeParam(params, 'nt'),
      });
      return {
        id: streamId,
        updated,
        items: await itemsOf(userId, page.entries),
        ...(page.cursor && { continuation: page.cursor }),
      };
    };
    reader.route({ method: read, url: '/stream/contents', handler: contents });
    reader.route({ method: read, url: '/stream/contents/*', handler: contents });

    reader.route({
      method: read,
      url: '/stream/items/ids',
      handler: async (request) => {
        const userId = readerSession(request).user.id;
        const params = readerParams(request);
        const resolved = await resolve(userId, streamIdOf(request, params));
        if (!resolved) return { itemRefs: [] };
        const { refs, cursor } = await entries.listIds(userId, {
          stream: resolved.stream,
          order: params.get('r') === 'o' ? 'oldest' : 'newest',
          cursor: params.get('c') ?? undefined,
          limit: pageSize(params, IDS_DEFAULT, IDS_MAX),
          flags: targets(request, params, resolved.flags),
          sortedFrom: timeParam(params, 'ot'),
          sortedBefore: timeParam(params, 'nt'),
        });
        return {
          itemRefs: refs.map((ref) => ({
            id: String(ref.id),
            directStreamIds:
              ref.subscriptionId === null ? [] : [`feed/${String(ref.subscriptionId)}`],
            timestampUsec: ref.sortAtUsec,
          })),
          ...(cursor && { continuation: cursor }),
        };
      },
    });

    reader.route({
      method: read,
      url: '/stream/items/contents',
      handler: async (request) => {
        const userId = readerSession(request).user.id;
        const ids = itemIds(readerParams(request)).slice(0, ITEMS_MAX);
        return {
          id: READING_LIST,
          updated: Math.floor(Date.now() / 1000),
          items: await itemsOf(userId, await entries.getMany(userId, ids)),
        };
      },
    });

    reader.post('/edit-tag', async (request, reply) => {
      const userId = readerSession(request).user.id;
      const params = readerParams(request);
      const ids = itemIds(params);
      const n = await names(userId);
      const labelChanges = new Map<number, boolean>();
      for (const [name, add] of [
        ['a', true],
        ['r', false],
      ] as const)
        for (const tag of params.getAll(name).map(normaliseStreamId)) {
          if (tag === READ) await entries.setState(userId, ids, { unread: !add });
          else if (tag === KEPT_UNREAD) {
            if (add) await entries.setState(userId, ids, { unread: true });
          } else if (tag === STARRED) await entries.setState(userId, ids, { starred: add });
          else if (tag === BROADCAST) await entries.setState(userId, ids, { published: add });
          else if (tag.startsWith(LABEL)) {
            const caption = tag.slice(LABEL.length);
            const label = add ? await labelFor(userId, n, caption) : n.labelNamed(caption);
            if (label) labelChanges.set(label.id, add);
          } else logUnsupported(request, 'greader', `edit-tag ${name}=${tag}`);
        }
      if (labelChanges.size > 0)
        for (const entry of await entries.getMany(userId, ids)) {
          const wanted = new Set(entry.labels);
          for (const [id, add] of labelChanges)
            if (add) wanted.add(id);
            else wanted.delete(id);
          if (wanted.size !== entry.labels.length || entry.labels.some((id) => !wanted.has(id)))
            await labelService.setEntryLabels(userId, entry.id, [...wanted]);
        }
      return ok(reply);
    });

    reader.post('/mark-all-as-read', async (request, reply) => {
      const userId = readerSession(request).user.id;
      const params = readerParams(request);
      const resolved = await resolve(userId, params.get('s') ?? READING_LIST);
      const usec = params.get('ts')?.trim();
      if (resolved)
        await entries.markRead(userId, resolved.stream, {
          deliveredBy:
            usec && /^\d+$/.test(usec) ? new Date(Number(BigInt(usec) / 1000n)) : undefined,
        });
      return ok(reply);
    });

    reader.post('/rename-tag', async (request, reply) => {
      const userId = readerSession(request).user.id;
      const params = readerParams(request);
      const from = normaliseStreamId(params.get('s') ?? params.get('t') ?? '');
      const to = normaliseStreamId(params.get('dest') ?? '');
      if (!from.startsWith(LABEL) || !to.startsWith(LABEL))
        return fail(reply, 400, 'Expected label stream ids');
      const name = from.slice(LABEL.length);
      const newName = to.slice(LABEL.length).trim();
      if (!newName) return fail(reply, 400, 'Empty name');
      const n = await names(userId);
      const folder = n.folderNamed(name);
      if (folder) {
        // Within the same parent the last path segment is the title; elsewhere the whole name.
        const parent = name.slice(0, name.length - folder.title.length);
        const title = parent && newName.startsWith(parent) ? newName.slice(parent.length) : newName;
        await feeds.categories.update(userId, folder.id, { title });
        return ok(reply);
      }
      const label = n.labelNamed(name);
      if (!label) return fail(reply, 404, 'Tag not found');
      await labelService.update(userId, label.id, { caption: newName });
      return ok(reply);
    });

    reader.post('/disable-tag', async (request, reply) => {
      const userId = readerSession(request).user.id;
      const params = readerParams(request);
      const tag = normaliseStreamId(params.get('s') ?? params.get('t') ?? '');
      if (!tag.startsWith(LABEL)) return fail(reply, 400, 'Expected a label stream id');
      const name = tag.slice(LABEL.length);
      const n = await names(userId);
      const folder = n.folderNamed(name);
      if (folder) await feeds.categories.delete(userId, folder.id);
      else {
        const label = n.labelNamed(name);
        if (!label) return fail(reply, 404, 'Tag not found');
        await labelService.delete(userId, label.id);
      }
      return ok(reply);
    });
  };
}
