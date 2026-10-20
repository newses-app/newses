import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deployConfigSchema } from './deploy-config.ts';

const example = JSON.parse(
  readFileSync(new URL('../deploy.config.example.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const parse = (changes: Record<string, unknown>) =>
  deployConfigSchema.safeParse({ ...example, ...changes });

describe('deploy config', () => {
  it("needs the first admin's login, and refuses well-known ones", () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ adminLogin: undefined }).success).toBe(false);
    for (const adminLogin of ['admin', 'admin2', 'root', 'sa']) {
      expect(parse({ adminLogin }).success, adminLogin).toBe(false);
    }
  });
});
