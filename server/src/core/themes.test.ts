import { MAX_THEMES_PER_USER } from '@newses/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import { themes, users } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { ThemeService } from './themes.ts';

let database: TestDatabase;
let db: Db;
let service: ThemeService;
let alice = 0;
let bob = 0;

const theme = (name: string) => ({ name, base: 'original' as const, tokens: { fontScale: 1.125 } });

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  service = new ThemeService(db);
});

beforeEach(async () => {
  await db.delete(users);
  const rows = await db
    .insert(users)
    .values([
      { login: 'alice', passwordHash: 'x' },
      { login: 'bob', passwordHash: 'x' },
    ])
    .returning();
  [alice, bob] = rows.map((row) => row.id) as [number, number];
});

afterAll(async () => {
  await database.drop();
});

describe('ThemeService', () => {
  it('creates themes and lists them by name with their author', async () => {
    await service.create(alice, theme('Dusk'));
    const created = await service.create(alice, theme('autumn'));
    expect(created.ownerLogin).toBe('alice');
    expect(created.theme).toMatchObject({ name: 'autumn', base: 'original', shared: false });
    expect(created.theme.tokens).toEqual({ fontScale: 1.125 });
    expect((await service.list(alice)).map((view) => view.theme.name)).toEqual(['autumn', 'Dusk']);
  });

  it('rejects a second theme with the same name, ignoring case, per user', async () => {
    await service.create(alice, theme('Dusk'));
    await expect(service.create(alice, theme('DUSK'))).rejects.toMatchObject({ code: 'conflict' });
    await expect(service.create(bob, theme('Dusk'))).resolves.toBeDefined();
    const other = await service.create(alice, theme('Dawn'));
    await expect(service.update(alice, other.theme.id, { name: 'dusk' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it("shows others' themes only while they are shared", async () => {
    const { theme: shared } = await service.create(alice, theme('Shared'));
    await service.create(alice, theme('Private'));
    expect(await service.list(bob)).toEqual([]);

    await service.update(alice, shared.id, { shared: true });
    const visible = await service.list(bob);
    expect(visible.map((view) => [view.theme.name, view.ownerLogin])).toEqual([
      ['Shared', 'alice'],
    ]);

    await service.update(alice, shared.id, { shared: false });
    expect(await service.list(bob)).toEqual([]);
  });

  it('lets only the author change or delete a theme, even a shared one', async () => {
    const { theme: row } = await service.create(alice, theme('Dusk'));
    await service.update(alice, row.id, { shared: true });
    await expect(service.update(bob, row.id, { name: 'Mine' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(service.delete(bob, row.id)).rejects.toMatchObject({ code: 'not_found' });

    const updated = await service.update(alice, row.id, {
      name: 'Night',
      tokens: { density: 'compact' },
    });
    expect(updated.theme).toMatchObject({ name: 'Night', tokens: { density: 'compact' } });
    expect(updated.theme.updatedAt.getTime()).toBeGreaterThanOrEqual(row.updatedAt.getTime());
    await service.delete(alice, row.id);
    expect(await service.list(alice)).toEqual([]);
  });

  it('limits themes per user', async () => {
    await db.insert(themes).values(
      Array.from({ length: MAX_THEMES_PER_USER }, (_, i) => ({
        ownerId: alice,
        name: `Theme ${String(i)}`,
        base: 'original',
        tokens: {},
      })),
    );
    await expect(service.create(alice, theme('One more'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(service.create(bob, theme('One more'))).resolves.toBeDefined();
  });

  it("deletes a user's themes with the user", async () => {
    await service.create(alice, theme('Dusk'));
    await db.delete(users).where(eq(users.id, alice));
    expect(await db.select().from(themes)).toEqual([]);
  });
});
