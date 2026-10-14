import type { CreateThemeRequest, Theme, UpdateThemeRequest } from '@newses/shared';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api } from '../api.ts';

export const THEMES_KEY = ['themes'] as const;

/** The user's themes and those others share. */
export function useThemes() {
  return useQuery({ queryKey: THEMES_KEY, queryFn: () => api.themes.list() });
}

/** Theme changes, each followed by refetching the list, so a theme in use updates once saved. */
export function useThemeActions() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: THEMES_KEY });

  async function create(theme: CreateThemeRequest): Promise<Theme> {
    const created = await api.themes.create(theme);
    await refresh();
    return created;
  }

  async function update(id: number, changes: UpdateThemeRequest): Promise<Theme> {
    const updated = await api.themes.update(id, changes);
    await refresh();
    return updated;
  }

  async function remove(id: number): Promise<void> {
    await api.themes.delete(id);
    await refresh();
  }

  return { create, update, remove };
}
