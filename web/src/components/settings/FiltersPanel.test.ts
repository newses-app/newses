import type { Filter } from '@newses/shared';
import { enableAutoUnmount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withoutIsolates } from '../../lib/message-params.ts';
import { i18n } from '../../plugins/i18n.ts';
import { useUiStore } from '../../stores/ui.ts';
import { button, mountInApp, overlay } from '../../test/mount.ts';
import { spyInvalidations } from '../../test/queries.ts';
import FiltersPanel from './FiltersPanel.vue';

const filters = vi.hoisted(() => ({
  list: vi.fn<() => Promise<object[]>>(),
  create: vi.fn<(body: object) => Promise<object>>(),
  update: vi.fn<(id: number, body: object) => Promise<object>>(),
  delete: vi.fn<(id: number) => Promise<void>>(),
  reorder: vi.fn<(order: number[]) => Promise<void>>(),
  test: vi.fn<(body: object) => Promise<object>>(),
  apply: vi.fn<(id: number, cursor?: string) => Promise<object>>(),
}));
vi.mock('../../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: {
    filters,
    subscriptions: { list: () => Promise.resolve([{ id: 5, title: 'Blog' }]) },
    categories: { list: () => Promise.resolve([{ id: 2, title: 'News' }]) },
    labels: { list: () => Promise.resolve([{ id: 9, caption: 'Later' }]) },
  },
}));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

const saved = (id: number, title: string): Filter => ({
  id,
  title,
  sortOrder: id,
  enabled: true,
  matchAny: false,
  inverse: false,
  rules: [{ field: 'title', pattern: title, inverse: false, categoryIds: [], subscriptionIds: [] }],
  actions: [{ type: 'markRead' }],
});

async function mounted() {
  const { wrapper, pinia, queryClient } = mountInApp(FiltersPanel);
  await flushPromises();
  return { panel: wrapper, ui: useUiStore(pinia), invalidations: spyInvalidations(queryClient) };
}

/** The button for `filter` whose accessible name starts with `action`'s. */
const filterButton = (panel: VueWrapper, label: string) => {
  const found = panel
    .findAll('button')
    .find((b) => withoutIsolates(b.attributes('aria-label') ?? '') === label);
  if (!found) throw new Error(`No button ${label}`);
  return found;
};
const named = (key: string, title: string) => withoutIsolates(t(key, { title }));

beforeEach(() => {
  for (const fn of Object.values(filters)) fn.mockReset();
  filters.list.mockResolvedValue([saved(1, 'Sport'), saved(2, 'Ads')]);
  filters.create.mockResolvedValue(saved(3, 'New'));
  filters.update.mockResolvedValue(saved(1, 'Sport'));
  filters.delete.mockResolvedValue();
  filters.reorder.mockResolvedValue();
});

describe('FiltersPanel', () => {
  it('lists the filters with what each has', async () => {
    const { panel } = await mounted();
    const sport = panel.get('[data-filter="Sport"]');
    expect(withoutIsolates(sport.text())).toContain('1 rule');
    expect(withoutIsolates(sport.text())).toContain('1 action');
  });

  it('says when there are none', async () => {
    filters.list.mockResolvedValue([]);
    const { panel } = await mounted();
    expect(panel.text()).toContain(t('filters.none'));
  });

  it('creates a filter once it is complete', async () => {
    const { panel, invalidations } = await mounted();
    await button(panel, t('filters.newFilter')).trigger('click');
    await flushPromises();
    const submit = () =>
      document.querySelector<HTMLButtonElement>('.v-dialog button[type="submit"]');
    expect(submit()?.disabled).toBe(true);
    await overlay().get(`input[maxlength="200"]`).setValue(' Sport ');
    await overlay().get('.pattern input').setValue('football');
    await flushPromises();
    expect(submit()?.disabled).toBe(false);
    await overlay().get('form').trigger('submit');
    await flushPromises();
    expect(filters.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Sport',
        rules: [expect.objectContaining({ field: 'title', pattern: 'football' })],
        actions: [{ type: 'markRead' }],
      }),
    );
    expect(invalidations.keys()).toContainEqual(['filters']);
    expect(document.querySelector('.v-dialog .v-card')).toBeNull();
  });

  it('adds and removes rules and actions', async () => {
    const { panel } = await mounted();
    await button(panel, t('filters.newFilter')).trigger('click');
    await flushPromises();
    const parts = () => overlay().findAll('fieldset').length;
    expect(parts()).toBe(2);
    await button(overlay(), t('filters.addRule')).trigger('click');
    await button(overlay(), t('filters.addAction')).trigger('click');
    expect(parts()).toBe(4);
    await overlay()
      .get(`button[aria-label="${withoutIsolates(t('filters.removeRule', { n: 2 }))}"]`)
      .trigger('click');
    expect(parts()).toBe(3);
  });

  it('tests a filter against recent entries before saving it', async () => {
    filters.test.mockResolvedValue({
      checked: 1000,
      matched: 1,
      matches: [{ id: 4, title: 'Goal!' }],
    });
    const { panel } = await mounted();
    await filterButton(panel, named('filters.editNamed', 'Sport')).trigger('click');
    await flushPromises();
    await button(overlay(), t('filters.test')).trigger('click');
    await flushPromises();
    expect(filters.test).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sport' }));
    expect(overlay().text()).toContain('Goal!');
    await overlay().get('form').trigger('submit');
    await flushPromises();
    expect(filters.update).toHaveBeenCalledWith(1, expect.objectContaining({ title: 'Sport' }));
  });

  it('applies a filter to existing entries page by page, once confirmed', async () => {
    filters.apply
      .mockResolvedValueOnce({ checked: 500, matched: 2, cursor: 'c1' })
      .mockResolvedValueOnce({ checked: 300, matched: 1, cursor: null });
    const { panel, ui, invalidations } = await mounted();
    await filterButton(panel, named('filters.applyNamed', 'Sport')).trigger('click');
    ui.confirmRequest?.resolve(true);
    await flushPromises();
    expect(filters.apply.mock.calls).toEqual([
      [1, undefined],
      [1, 'c1'],
    ]);
    expect(withoutIsolates(ui.notice?.text ?? '')).toBe(
      withoutIsolates(t('filters.applied', { checked: 800, matched: 3 })),
    );
    expect(invalidations.keys()).toEqual([['entries'], ['counters']]);
  });

  it('says when applying fails, and applies nothing unconfirmed', async () => {
    filters.apply.mockRejectedValue(new TypeError('Failed to fetch'));
    const { panel, ui } = await mounted();
    await filterButton(panel, named('filters.applyNamed', 'Sport')).trigger('click');
    ui.confirmRequest?.resolve(false);
    await flushPromises();
    expect(filters.apply).not.toHaveBeenCalled();
    await filterButton(panel, named('filters.applyNamed', 'Sport')).trigger('click');
    ui.confirmRequest?.resolve(true);
    await flushPromises();
    expect(ui.notice).toEqual({ text: t('errors.generic'), error: true });
  });

  it('moves, turns off, and deletes filters', async () => {
    const { panel, ui } = await mounted();
    await filterButton(panel, named('filters.moveDown', 'Sport')).trigger('click');
    await flushPromises();
    expect(filters.reorder).toHaveBeenCalledWith([2, 1]);
    expect(
      filterButton(panel, named('filters.moveUp', 'Sport')).attributes('disabled'),
    ).toBeDefined();

    await panel.get('[data-filter="Ads"] input[type="checkbox"]').setValue(false);
    await flushPromises();
    expect(filters.update).toHaveBeenCalledWith(2, expect.objectContaining({ enabled: false }));

    await filterButton(panel, named('filters.deleteNamed', 'Ads')).trigger('click');
    ui.confirmRequest?.resolve(true);
    await flushPromises();
    expect(filters.delete).toHaveBeenCalledWith(2);
  });
});
