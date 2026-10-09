// Filter fields, actions, and limits shared by the API and the web app (no Zod).

export const FILTER_FIELDS = [
  'title',
  'content',
  'titleOrContent',
  'author',
  'link',
  'tag',
] as const;
export const FILTER_ACTIONS = [
  'delete',
  'markRead',
  'star',
  'publish',
  'label',
  'tag',
  'score',
  'stop',
] as const;
export const MAX_FILTER_RULES = 20;
export const MAX_FILTER_ACTIONS = 20;
export const MAX_FILTER_PATTERN = 1000;
