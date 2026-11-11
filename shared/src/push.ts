import { z } from 'zod';

/** Push service addresses; the longest seen in browsers and UnifiedPush are well under this. */
export const MAX_PUSH_ENDPOINT_LENGTH = 2048;

/**
 * `PUT /push/subscription`: where this session's device receives Web Push messages (RFC 8030),
 * as `PushSubscription.toJSON()` gives it. A session has at most one; a later one replaces it.
 */
export const pushSubscriptionRequestSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(MAX_PUSH_ENDPOINT_LENGTH),
  keys: z.object({
    /** The device's P-256 public key, uncompressed (65 bytes), base64url (RFC 8291). */
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}=?$/, 'Expected 65 bytes in base64url'),
    /** The device's authentication secret (16 bytes), base64url (RFC 8291). */
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}(==)?$/, 'Expected 16 bytes in base64url'),
  }),
});

export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionRequestSchema>;

/** A place with new entries: a category, or a feed outside any category. */
export interface PushPlace {
  title: string;
  count: number;
}

/**
 * What a push message carries, as JSON: the user's unread entries that arrived since their last
 * message, which the device words in its own language.
 */
export interface PushMessage {
  type: 'new-entries';
  count: number;
  /** Most entries first; the rest are counted in `morePlaces`. */
  places: PushPlace[];
  morePlaces: number;
  /** The stream to open: `/f<id>` for one feed, `/c<id>` for one category (`c0` none), `/all`. */
  target: string;
}
