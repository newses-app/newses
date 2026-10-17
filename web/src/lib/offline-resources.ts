import type {
  Category,
  CreateCategoryRequest,
  CreateLabelRequest,
  CreateThemeRequest,
  Label,
  Prefs,
  SubscribeRequest,
  Subscription,
  Theme,
  UpdateCategoryRequest,
  UpdateLabelRequest,
  UpdatePrefsRequest,
  UpdateSubscriptionRequest,
  UpdateThemeRequest,
} from '@newses/shared';

/** What edits outside articles change, each with its own ids. */
export type Resource = 'category' | 'subscription' | 'label' | 'theme';

/**
 * A change to preferences, feeds, categories, labels, or themes made on this device and not yet
 * sent. Creates carry the temporary (negative) id the device gave the new object.
 */
export type ResourceOp =
  | { kind: 'prefs'; changes: UpdatePrefsRequest }
  | { kind: 'category.create'; id: number; body: CreateCategoryRequest }
  | { kind: 'category.update'; id: number; changes: UpdateCategoryRequest }
  /** With its parent, where its feeds and subcategories move, as on the server. */
  | { kind: 'category.delete'; id: number; parentId: number | null }
  | { kind: 'categories.collapse'; collapsed: boolean }
  | { kind: 'subscription.create'; id: number; body: SubscribeRequest }
  | { kind: 'subscription.update'; id: number; changes: UpdateSubscriptionRequest }
  | { kind: 'subscription.delete'; id: number }
  | { kind: 'label.create'; id: number; body: CreateLabelRequest }
  | { kind: 'label.update'; id: number; changes: UpdateLabelRequest }
  | { kind: 'label.delete'; id: number }
  | { kind: 'theme.create'; id: number; body: CreateThemeRequest }
  | { kind: 'theme.update'; id: number; changes: UpdateThemeRequest }
  | { kind: 'theme.delete'; id: number };

export type ResourceKind = ResourceOp['kind'];

const RESOURCE_KINDS: ReadonlySet<string> = new Set<ResourceKind>([
  'prefs',
  'category.create',
  'category.update',
  'category.delete',
  'categories.collapse',
  'subscription.create',
  'subscription.update',
  'subscription.delete',
  'label.create',
  'label.update',
  'label.delete',
  'theme.create',
  'theme.update',
  'theme.delete',
]);

export const isResourceOp = (op: { kind: string }): op is ResourceOp => RESOURCE_KINDS.has(op.kind);

/** The resource a create, update, or delete is about. */
export function resourceOf(op: ResourceOp): Resource | null {
  const [resource] = op.kind.split('.');
  return resource === 'category' ||
    resource === 'subscription' ||
    resource === 'label' ||
    resource === 'theme'
    ? resource
    : null;
}

export const isCreate = (op: { kind: string }) => op.kind.endsWith('.create');

/** Temporary ids are negative, so they never meet the server's; unique on this device. */
let counter = 0;
export function temporaryId(now = Date.now()): number {
  counter = (counter + 1) % 100;
  return -(now * 100 + counter);
}

export const isTemporary = (id: number | null | undefined) => typeof id === 'number' && id < 0;

/** A placeholder sort order: after everything the server numbered. */
const LAST = 1_000_000_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** A feed subscribed offline, as it shows until the server answers. */
export function pendingSubscription(id: number, body: SubscribeRequest): Subscription {
  return {
    id,
    feedSourceId: 0,
    title: hostOf(body.url),
    customTitle: null,
    url: body.url,
    siteUrl: null,
    categoryId: body.categoryId ?? null,
    sortOrder: LAST,
    iconUrl: null,
    lastFetchedAt: null,
    lastError: null,
    lastErrorAt: null,
    errorCount: 0,
    disabled: false,
    updateIntervalMinutes: null,
    purgeDays: null,
    fullText: false,
  };
}

/** A theme created offline, as it shows until the server has it. */
export function pendingTheme(id: number, body: CreateThemeRequest, at = Date.now()): Theme {
  return {
    id,
    ...body,
    shared: false,
    owner: { id: 0, login: '' },
    mine: true,
    updatedAt: new Date(at).toISOString(),
  };
}

const upsert = <T extends { id: number }>(list: readonly T[], item: T) =>
  list.some((x) => x.id === item.id) ? [...list] : [...list, item];

/** Fields of a change that are set; an absent field stays as it is. */
const defined = (change: object) =>
  Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined));

const merge = <T extends { id: number }>(list: readonly T[], id: number, change: object): T[] =>
  list.map((x) => (x.id === id ? { ...x, ...defined(change) } : x));

export function applyToCategories(list: readonly Category[], op: ResourceOp): Category[] {
  switch (op.kind) {
    case 'category.create':
      return upsert(list, {
        id: op.id,
        title: op.body.title,
        parentId: op.body.parentId ?? null,
        sortOrder: LAST,
        collapsed: false,
      });
    case 'category.update': {
      const { title, parentId, sortOrder, collapsed } = op.changes;
      return merge(list, op.id, {
        ...(title !== undefined && { title }),
        ...(parentId !== undefined && { parentId }),
        ...(sortOrder !== undefined && { sortOrder }),
        ...(collapsed !== undefined && { collapsed }),
      });
    }
    case 'category.delete':
      return list
        .filter((c) => c.id !== op.id)
        .map((c) => (c.parentId === op.id ? { ...c, parentId: op.parentId } : c));
    case 'categories.collapse':
      return list.map((c) => ({ ...c, collapsed: op.collapsed }));
    default:
      return [...list];
  }
}

export function applyToSubscriptions(
  list: readonly Subscription[],
  op: ResourceOp,
): Subscription[] {
  switch (op.kind) {
    case 'subscription.create':
      return upsert(list, pendingSubscription(op.id, op.body));
    case 'subscription.update': {
      const { title, ...rest } = op.changes;
      const change: Partial<Subscription> = Object.fromEntries(
        Object.entries(rest).filter(([, value]) => value !== undefined),
      );
      return list.map((s) =>
        s.id === op.id
          ? {
              ...s,
              ...change,
              ...(title !== undefined && { customTitle: title, title: title ?? s.title }),
            }
          : s,
      );
    }
    case 'subscription.delete':
      return list.filter((s) => s.id !== op.id);
    case 'category.delete':
      return list.map((s) => (s.categoryId === op.id ? { ...s, categoryId: op.parentId } : s));
    default:
      return [...list];
  }
}

export function applyToLabels(list: readonly Label[], op: ResourceOp): Label[] {
  switch (op.kind) {
    case 'label.create':
      return upsert(list, { id: op.id, ...op.body });
    case 'label.update':
      return merge(list, op.id, op.changes);
    case 'label.delete':
      return list.filter((l) => l.id !== op.id);
    default:
      return [...list];
  }
}

export function applyToThemes(list: readonly Theme[], op: ResourceOp, at = Date.now()): Theme[] {
  switch (op.kind) {
    case 'theme.create':
      return upsert(list, pendingTheme(op.id, op.body, at));
    case 'theme.update':
      return merge(list, op.id, op.changes);
    case 'theme.delete':
      return list.filter((t) => t.id !== op.id);
    default:
      return [...list];
  }
}

export function applyToPrefs(prefs: Prefs, op: ResourceOp): Prefs {
  return op.kind === 'prefs' ? ({ ...prefs, ...op.changes } as Prefs) : prefs;
}

/**
 * Whether `op` refers to the `resource` with `id`: as its subject, or as a category a feed or
 * category goes in, a label set on an entry, or the theme in use.
 */
export function refersTo(op: unknown, resource: Resource, id: number): boolean {
  return JSON.stringify(remapIds(op, resource, id, Number.NaN)) !== JSON.stringify(op);
}

type Remappable = Record<string, unknown> & { kind: string };

/**
 * `op` with references to the `resource` with id `from` changed to `to`; for after the server gave
 * a created object its id. Covers resource changes and the article changes that name labels or
 * streams.
 */
export function remapIds<T>(op: T, resource: Resource, from: number, to: number | null): T {
  if (typeof op !== 'object' || op === null || !('kind' in op)) return op;
  const o = op as Remappable;
  const swap = (value: unknown) => (value === from ? to : value);
  const swapAll = (value: unknown) => (Array.isArray(value) ? value.map(swap) : value);
  const kindResource = o.kind.split('.')[0];
  const out: Remappable = { ...o };
  if (kindResource === resource && 'id' in o) out.id = swap(o.id);
  const field = (key: string, inner: string) => {
    const value = o[key];
    if (typeof value === 'object' && value !== null && inner in value)
      out[key] = { ...value, [inner]: swap((value as Record<string, unknown>)[inner]) };
  };
  if (resource === 'category') {
    field('body', 'parentId');
    field('changes', 'parentId');
    if (o.kind.startsWith('subscription.')) {
      field('body', 'categoryId');
      field('changes', 'categoryId');
    }
    if (o.kind === 'markRead') field('request', 'categoryId');
  }
  if (resource === 'subscription' && o.kind === 'markRead') field('request', 'subscriptionId');
  if (resource === 'label') {
    if (o.kind === 'labels') {
      out.labelIds = swapAll(o.labelIds);
      if ('base' in o) out.base = swapAll(o.base);
    }
    if (o.kind === 'markRead') field('request', 'labelId');
  }
  if (resource === 'theme' && o.kind === 'prefs') field('changes', 'appearanceTheme');
  return out as T;
}

/**
 * A snapshot query's data with changes still waiting applied, so lists loaded from the server or
 * the store show them. Applying a change twice changes nothing.
 */
export function applyResourceOps<T>(name: string, data: T, ops: readonly ResourceOp[]): T {
  if (data === undefined || data === null || ops.length === 0) return data;
  const fold = <L>(apply: (value: L, op: ResourceOp) => L) =>
    ops.reduce((value, op) => apply(value, op), data as unknown as L) as unknown as T;
  switch (name) {
    case 'categories':
      return fold(applyToCategories);
    case 'subscriptions':
      return fold(applyToSubscriptions);
    case 'labels':
      return fold(applyToLabels);
    case 'themes':
      return fold((list: Theme[], op) => applyToThemes(list, op));
    case 'prefs':
      return fold(applyToPrefs);
    default:
      return data;
  }
}
