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

  it('takes an ECR Public repository for the server image, or none', () => {
    const stages = example.stages as Record<string, unknown>[];
    const withImage = (imageRepository: string | undefined) =>
      parse({ stages: stages.map((stage) => ({ ...stage, imageRepository })) }).success;
    expect(withImage(undefined)).toBe(true);
    for (const uri of [
      'public.ecr.aws/newses/newses',
      'public.ecr.aws/a1b2c3d4/team/newses-server',
    ]) {
      expect(withImage(uri), uri).toBe(true);
    }
    for (const uri of [
      'ghcr.io/newses-app/newses',
      'public.ecr.aws/newses/newses:1.2.3',
      'public.ecr.aws/newses/newses@sha256:0',
      'public.ecr.aws/Newses/newses',
      'public.ecr.aws/newses',
      'https://public.ecr.aws/newses/newses',
    ]) {
      expect(withImage(uri), uri).toBe(false);
    }
  });
});
