import type { ComputedRef, InjectionKey, Ref } from 'vue';
import type { Dragged, useTreeEditing } from '../../composables/useTreeEditing.ts';

export interface TreeContext {
  dragged: Ref<Dragged | null>;
  editing: ReturnType<typeof useTreeEditing>;
  /** The open stream's key. */
  current: ComputedRef<string | undefined>;
}

export const TREE_CONTEXT: InjectionKey<TreeContext> = Symbol('feed-tree');
