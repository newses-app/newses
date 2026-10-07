import { z } from 'zod';

const color = z.string().regex(/^#[0-9a-f]{6}$/i, 'Expected a #rrggbb colour');

export const labelSchema = z.object({
  id: z.number().int(),
  caption: z.string(),
  /** `#rrggbb` text colour. */
  fgColor: z.string(),
  /** `#rrggbb` background colour. */
  bgColor: z.string(),
});

export const createLabelRequestSchema = z.object({
  caption: z.string().trim().min(1).max(100),
  fgColor: color,
  bgColor: color,
});

export const updateLabelRequestSchema = createLabelRequestSchema.partial();

/** Replaces the entry's labels. */
export const entryLabelsRequestSchema = z.object({
  labelIds: z.array(z.number().int()).max(100),
});

export type Label = z.infer<typeof labelSchema>;
export type CreateLabelRequest = z.infer<typeof createLabelRequestSchema>;
export type UpdateLabelRequest = z.infer<typeof updateLabelRequestSchema>;
