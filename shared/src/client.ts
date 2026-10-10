import type { z } from 'zod';
import type {
  AppConnection,
  AppPassword,
  changePasswordRequestSchema,
  CreateAppPasswordResponse,
  createAppPasswordRequestSchema,
  createUserRequestSchema,
  CurrentSession,
  LoggedInResponse,
  LoginResponse,
  loginRequestSchema,
  loginTwoFactorRequestSchema,
  Session,
  TwoFactorSetup,
  TwoFactorStatus,
  updateUserRequestSchema,
  User,
} from './auth.ts';
import type { Filter, FilterApplyResponse, FilterRequest, FilterTestResponse } from './filters.ts';
import type {
  BulkEntryStateRequest,
  Counters,
  Entry,
  EntryListQuery,
  EntryListResponse,
  EntryNoteRequest,
  EntryState,
  FullTextResponse,
  MarkReadRequest,
  PublishedFeedResponse,
  ShareResponse,
  SyncResponse,
  TagCount,
} from './entries.ts';
import type {
  Category,
  CreateCategoryRequest,
  OpmlImportResult,
  SubscribeRequest,
  SubscribeResponse,
  Subscription,
  UpdateAllCategoriesRequest,
  UpdateCategoryRequest,
  UpdateSubscriptionRequest,
} from './feeds.ts';
import type { CreateLabelRequest, Label, UpdateLabelRequest } from './labels.ts';
import type { Prefs, UpdatePrefsRequest } from './prefs.ts';
import type { ServerInfo } from './server.ts';

export interface ApiClientOptions {
  /**
   * Server origin, e.g. `https://reader.example`; empty for the page's own origin. A function is
   * read on every request, for apps whose server can change.
   */
  baseUrl?: string | (() => string);
  /**
   * Bearer token (desktop and mobile apps), or a function returning the current one (null while
   * signed out). Bearer clients never send cookies; without this option, the session cookie is used.
   */
  token?: string | (() => string | null);
  fetch?: typeof fetch;
}

/** A non-2xx response; `code` is the API's error code (e.g. `unauthenticated`, `not_found`). */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string;
  /** Seconds from Retry-After on 429 responses. */
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string, message: string, retryAfterSeconds: number | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  query?: Query | undefined;
  body?: unknown;
  /** Sent as-is with this content type instead of JSON. */
  rawBody?: { data: string; contentType: string };
  /** Return the response text instead of parsing JSON. */
  text?: boolean;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Typed client for `/api/v1`. Remembers the CSRF token from login and session calls. */
export function createApiClient(options: ApiClientOptions = {}) {
  const { baseUrl = '', token: tokenOption } = options;
  const base = () =>
    `${(typeof baseUrl === 'function' ? baseUrl() : baseUrl).replace(/\/$/, '')}/api/v1`;
  const bearer = tokenOption !== undefined;
  const currentToken = () => (typeof tokenOption === 'function' ? tokenOption() : tokenOption);
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  let csrfToken: string | null = null;

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query ?? {}))
      if (value !== undefined) params.set(key, String(value));
    const search = params.size > 0 ? `?${params.toString()}` : '';
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = currentToken();
    if (token) headers.authorization = `Bearer ${token}`;
    else if (!bearer && csrfToken && !SAFE_METHODS.has(method)) headers['x-csrf-token'] = csrfToken;
    let body: string | undefined;
    if (opts.rawBody) {
      headers['content-type'] = opts.rawBody.contentType;
      body = opts.rawBody.data;
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const response = await doFetch(`${base()}${path}${search}`, {
      method,
      headers,
      ...(body !== undefined && { body }),
      credentials: bearer ? 'omit' : 'include',
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ApiError(
        response.status,
        error.error ?? 'http_error',
        error.message ?? `HTTP ${String(response.status)}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
    if (opts.text) return (await response.text()) as T;
    if (response.status === 202 || response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const id = (value: number) => encodeURIComponent(String(value));

  return {
    /** URL of the server-sent events stream (`counters` events). */
    get eventsUrl() {
      return `${base()}/events`;
    },
    setCsrfToken(token: string | null) {
      csrfToken = token;
    },

    /** Product, build, and API version; needs no session. */
    serverInfo: () => request<ServerInfo>('GET', '/server'),

    auth: {
      /** Opens a session, or returns a challenge to finish with `loginTwoFactor`. */
      async login(body: z.input<typeof loginRequestSchema>) {
        const result = await request<LoginResponse>('POST', '/auth/login', { body });
        if ('user' in result) csrfToken = result.csrfToken ?? csrfToken;
        return result;
      },
      async loginTwoFactor(body: z.input<typeof loginTwoFactorRequestSchema>) {
        const result = await request<LoggedInResponse>('POST', '/auth/login/2fa', { body });
        csrfToken = result.csrfToken ?? csrfToken;
        return result;
      },
      async logout() {
        await request<undefined>('POST', '/auth/logout');
        csrfToken = null;
      },
      async session() {
        const result = await request<CurrentSession>('GET', '/auth/session');
        csrfToken = result.csrfToken;
        return result;
      },
      sessions: () => request<Session[]>('GET', '/auth/sessions'),
      revokeSession: (sessionId: number) =>
        request<undefined>('DELETE', `/auth/sessions/${id(sessionId)}`),
      changePassword: (body: z.input<typeof changePasswordRequestSchema>) =>
        request<undefined>('POST', '/auth/password', { body }),
      appPasswords: {
        list: () => request<AppPassword[]>('GET', '/auth/app-passwords'),
        connection: () => request<AppConnection>('GET', '/auth/app-passwords/connection'),
        create: (body: z.input<typeof createAppPasswordRequestSchema>) =>
          request<CreateAppPasswordResponse>('POST', '/auth/app-passwords', { body }),
        revoke: (appPasswordId: number) =>
          request<undefined>('DELETE', `/auth/app-passwords/${id(appPasswordId)}`),
      },
      twoFactor: {
        status: () => request<TwoFactorStatus>('GET', '/auth/2fa'),
        setup: (password: string) =>
          request<TwoFactorSetup>('POST', '/auth/2fa/setup', { body: { password } }),
        enable: (code: string) =>
          request<{ recoveryCodes: string[] }>('POST', '/auth/2fa/enable', { body: { code } }),
        disable: (password: string, code: string) =>
          request<undefined>('POST', '/auth/2fa/disable', { body: { password, code } }),
        regenerateRecoveryCodes: (code: string) =>
          request<{ recoveryCodes: string[] }>('POST', '/auth/2fa/recovery-codes', {
            body: { code },
          }),
      },
    },

    admin: {
      users: () => request<User[]>('GET', '/admin/users'),
      createUser: (body: z.input<typeof createUserRequestSchema>) =>
        request<User>('POST', '/admin/users', { body }),
      updateUser: (userId: number, body: z.input<typeof updateUserRequestSchema>) =>
        request<User>('PATCH', `/admin/users/${id(userId)}`, { body }),
      resetPassword: (userId: number, password: string) =>
        request<undefined>('POST', `/admin/users/${id(userId)}/password`, { body: { password } }),
      deleteUser: (userId: number) => request<undefined>('DELETE', `/admin/users/${id(userId)}`),
      resetTwoFactor: (userId: number) =>
        request<undefined>('POST', `/admin/users/${id(userId)}/2fa/reset`),
    },

    categories: {
      list: () => request<Category[]>('GET', '/categories'),
      create: (body: CreateCategoryRequest) => request<Category>('POST', '/categories', { body }),
      update: (categoryId: number, body: UpdateCategoryRequest) =>
        request<Category>('PATCH', `/categories/${id(categoryId)}`, { body }),
      /** Applies the changes to every category, e.g. to expand or collapse them all. */
      updateAll: (body: UpdateAllCategoriesRequest) =>
        request<undefined>('PATCH', '/categories', { body }),
      delete: (categoryId: number) => request<undefined>('DELETE', `/categories/${id(categoryId)}`),
    },

    subscriptions: {
      list: () => request<Subscription[]>('GET', '/subscriptions'),
      subscribe: (body: SubscribeRequest) =>
        request<SubscribeResponse>('POST', '/subscriptions', { body }),
      update: (subscriptionId: number, body: UpdateSubscriptionRequest) =>
        request<Subscription>('PATCH', `/subscriptions/${id(subscriptionId)}`, { body }),
      unsubscribe: (subscriptionId: number) =>
        request<undefined>('DELETE', `/subscriptions/${id(subscriptionId)}`),
      /** Rejects with `throttled` while the feed's host has asked not to be fetched. */
      refresh: (subscriptionId: number) =>
        request<undefined>('POST', `/subscriptions/${id(subscriptionId)}/refresh`),
    },

    opml: {
      import: (xml: string) =>
        request<OpmlImportResult>('POST', '/opml', {
          rawBody: { data: xml, contentType: 'text/x-opml' },
        }),
      export: () => request<string>('GET', '/opml', { text: true }),
    },

    entries: {
      list: (query: EntryListQuery = {}) =>
        request<EntryListResponse>('GET', '/entries', { query: query as Query }),
      get: (entryId: number) => request<Entry>('GET', `/entries/${id(entryId)}`),
      update: (entryId: number, body: EntryState) =>
        request<Entry>('PATCH', `/entries/${id(entryId)}`, { body }),
      updateMany: (body: BulkEntryStateRequest) =>
        request<{ updated: number }>('PATCH', '/entries', { body }),
      /** Null or blank text clears the note. */
      setNote: (entryId: number, note: EntryNoteRequest['note']) =>
        request<undefined>('PUT', `/entries/${id(entryId)}/note`, { body: { note } }),
      /** Shares the entry at `/public/share/<shareId>`; the same id while it stays shared. */
      /** The linked page's article, extracted now unless it was before. */
      fullText: (entryId: number) =>
        request<FullTextResponse>('POST', `/entries/${id(entryId)}/full-text`),
      share: (entryId: number) => request<ShareResponse>('PUT', `/entries/${id(entryId)}/share`),
      unshare: (entryId: number) => request<undefined>('DELETE', `/entries/${id(entryId)}/share`),
      /** Replaces the entry's tags; resolves to them normalised. */
      setTags: (entryId: number, tags: string[]) =>
        request<{ tags: string[] }>('PUT', `/entries/${id(entryId)}/tags`, { body: { tags } }),
      /** Replaces the entry's labels. */
      setLabels: (entryId: number, labelIds: number[]) =>
        request<undefined>('PUT', `/entries/${id(entryId)}/labels`, { body: { labelIds } }),
      markRead: (body: MarkReadRequest) =>
        request<{ updated: number }>('POST', '/entries/mark-read', { body }),
    },

    labels: {
      list: () => request<Label[]>('GET', '/labels'),
      create: (body: CreateLabelRequest) => request<Label>('POST', '/labels', { body }),
      update: (labelId: number, body: UpdateLabelRequest) =>
        request<Label>('PATCH', `/labels/${id(labelId)}`, { body }),
      delete: (labelId: number) => request<undefined>('DELETE', `/labels/${id(labelId)}`),
    },

    filters: {
      list: () => request<Filter[]>('GET', '/filters'),
      create: (body: FilterRequest) => request<Filter>('POST', '/filters', { body }),
      update: (filterId: number, body: FilterRequest) =>
        request<Filter>('PUT', `/filters/${id(filterId)}`, { body }),
      delete: (filterId: number) => request<undefined>('DELETE', `/filters/${id(filterId)}`),
      reorder: (filterIds: number[]) =>
        request<Filter[]>('PUT', '/filters/order', { body: { filterIds } }),
      /** The user's recent entries a filter, saved or not, would match. */
      test: (body: FilterRequest) => request<FilterTestResponse>('POST', '/filters/test', { body }),
      /** Runs a saved filter over existing entries; repeat with the cursor until it is null. */
      apply: (filterId: number, cursor?: string) =>
        request<FilterApplyResponse>('POST', `/filters/${id(filterId)}/apply`, {
          body: cursor === undefined ? {} : { cursor },
        }),
    },

    /** The user's shared entries, newest first. */
    shares: () => request<Entry[]>('GET', '/shares'),

    /** The key in the published feed URL, `/public/feeds/<key>`. */
    publishedFeed: {
      get: () => request<PublishedFeedResponse>('GET', '/published-feed'),
      regenerate: () => request<PublishedFeedResponse>('POST', '/published-feed/regenerate'),
    },

    /** The user's tags with entry counts. */
    tags: () => request<TagCount[]>('GET', '/tags'),

    counters: () => request<Counters>('GET', '/counters'),
    /** Omit `since` for a full sync; call again with `next` while `more` is true. */
    sync: (since?: string, limit?: number) =>
      request<SyncResponse>('GET', '/sync', { query: { since, limit } }),

    prefs: {
      get: () => request<Prefs>('GET', '/prefs'),
      update: (body: UpdatePrefsRequest) => request<Prefs>('PATCH', '/prefs', { body }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
