import type { CreateThemeRequest, Theme, UpdateThemeRequest } from '@newses/shared';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api } from '../api.ts';
import { pendingTheme, temporaryId } from '../lib/offline-resources.ts';
import { storedQuery } from '../offline/local.ts';
import { useResourceEdits } from './useResourceEdits.ts';

export const THEMES_KEY = ['themes'] as const;

/**
 * The user's themes and those others share. Shared themes change elsewhere, so authors' edits and
 * unpublished themes show when the app regains focus.
 */
export function useThemes() {
  return useQuery({
    queryKey: THEMES_KEY,
    ...storedQuery('themes', () => api.themes.list()),
    refetchOnWindowFocus: 'always',
  });
}

/**
 * Theme changes, each followed by refetching the list once sent, so a theme in use updates; without
 * a connection they are kept and shown until they can be.
 */
export function useThemeActions() {
  const queryClient = useQueryClient();
  const { edit } = useResourceEdits();
  const refresh = () => queryClient.invalidateQueries({ queryKey: THEMES_KEY });
  const cached = (id: number) =>
    queryClient.getQueryData<Theme[]>(THEMES_KEY)?.find((theme) => theme.id === id);

  /** The theme made, or one with a temporary id until the server has it. */
  async function create(theme: CreateThemeRequest): Promise<Theme> {
    const id = temporaryId();
    const saved = await edit({ kind: 'theme.create', id, body: theme }, () =>
      api.themes.create(theme),
    );
    if (!saved.sent) return cached(id) ?? pendingTheme(id, theme);
    await refresh();
    return saved.value;
  }

  async function update(id: number, changes: UpdateThemeRequest): Promise<Theme | undefined> {
    const saved = await edit({ kind: 'theme.update', id, changes }, () =>
      api.themes.update(id, changes),
    );
    if (!saved.sent) return cached(id);
    await refresh();
    return saved.value;
  }

  async function remove(id: number): Promise<void> {
    const saved = await edit({ kind: 'theme.delete', id }, () => api.themes.delete(id));
    if (saved.sent) await refresh();
  }

  /** Withdraws another user's shared theme (admins); needs the server. */
  async function unpublish(id: number): Promise<void> {
    await api.admin.unpublishTheme(id);
    await refresh();
  }

  return { create, update, remove, unpublish };
}
