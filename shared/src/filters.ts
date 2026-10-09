import { z } from 'zod';
import { entrySchema } from './entries.ts';
import {
  FILTER_ACTIONS,
  FILTER_FIELDS,
  MAX_FILTER_ACTIONS,
  MAX_FILTER_PATTERN,
  MAX_FILTER_RULES,
} from './filter-options.ts';
import { MAX_SCORE } from './limits.ts';

export const filterFieldSchema = z.enum(FILTER_FIELDS);
export const filterActionTypeSchema = z.enum(FILTER_ACTIONS);

/** A rule matches entries whose field matches `pattern` (RE2 syntax, case-insensitive). */
export const filterRuleSchema = z.object({
  field: filterFieldSchema,
  pattern: z.string().min(1).max(MAX_FILTER_PATTERN),
  inverse: z.boolean().default(false),
  /** Limits the rule to these subscriptions and categories (with subcategories); empty for all. */
  subscriptionIds: z.array(z.number().int()).max(500).default([]),
  categoryIds: z.array(z.number().int()).max(500).default([]),
});

export const filterActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['delete', 'markRead', 'star', 'publish', 'stop']) }),
  z.object({ type: z.literal('label'), labelId: z.number().int() }),
  z.object({ type: z.literal('tag'), tag: z.string().trim().min(1).max(200) }),
  z.object({
    type: z.literal('score'),
    score: z.number().int().min(-MAX_SCORE).max(MAX_SCORE),
  }),
]);

const filterFields = {
  title: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  /** Matches when any rule matches, else when all do. */
  matchAny: z.boolean().default(false),
  /** Matches entries the rules do not match. */
  inverse: z.boolean().default(false),
  rules: z.array(filterRuleSchema).min(1).max(MAX_FILTER_RULES),
  actions: z.array(filterActionSchema).min(1).max(MAX_FILTER_ACTIONS),
};

/** A filter as saved or tested; saving replaces the whole filter. */
export const filterRequestSchema = z.object(filterFields);

export const filterSchema = z.object({
  id: z.number().int(),
  sortOrder: z.number().int(),
  ...filterFields,
  enabled: z.boolean(),
  matchAny: z.boolean(),
  inverse: z.boolean(),
  rules: z.array(filterRuleSchema.required()),
});

/** New order of the user's filters, first to last. */
export const filterOrderRequestSchema = z.object({
  filterIds: z.array(z.number().int()).max(1000),
});

export const filterTestResponseSchema = z.object({
  /** Entries checked: the user's most recent ones. */
  checked: z.number().int(),
  /** Matching entries, most recent first, at most 50. */
  matches: z.array(entrySchema),
  matched: z.number().int(),
});

export const filterApplyRequestSchema = z.object({ cursor: z.string().max(200).optional() });

export const filterApplyResponseSchema = z.object({
  checked: z.number().int(),
  matched: z.number().int(),
  /** Continue with this to apply to older entries; null once every entry was checked. */
  cursor: z.string().nullable(),
});

export type FilterField = z.infer<typeof filterFieldSchema>;
export type FilterActionType = z.infer<typeof filterActionTypeSchema>;
export type FilterRule = z.infer<typeof filterRuleSchema>;
export type FilterAction = z.infer<typeof filterActionSchema>;
export type FilterRequest = z.input<typeof filterRequestSchema>;
export type Filter = z.infer<typeof filterSchema>;
export type FilterTestResponse = z.infer<typeof filterTestResponseSchema>;
export type FilterApplyResponse = z.infer<typeof filterApplyResponseSchema>;
