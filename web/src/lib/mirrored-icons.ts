import {
  mdiArrowLeft,
  mdiChevronRight,
  mdiLogout,
  mdiOpenInNew,
  mdiSort,
  mdiTrendingDown,
  mdiTrendingUp,
} from '@mdi/js';
import { type Component, type FunctionalComponent, h, mergeProps } from 'vue';
import type { IconProps, IconSet } from 'vuetify';
import { VSvgIcon } from 'vuetify/components';

/** Icons that point along the reading direction; `styles.css` flips them right to left. */
const MIRRORED = new Set([
  mdiArrowLeft,
  mdiChevronRight,
  mdiLogout,
  mdiOpenInNew,
  mdiSort,
  mdiTrendingDown,
  mdiTrendingUp,
]);

const SvgIcon: FunctionalComponent<IconProps> = (props, { attrs }) =>
  h(
    VSvgIcon as Component,
    mergeProps(
      attrs,
      { ...props },
      {
        class: MIRRORED.has(props.icon as string) ? 'mirrored-icon' : undefined,
      },
    ),
  );

/** Vuetify's `mdi-svg` set, with the mirrored class; its own `svg:` aliases flip themselves. */
export const mirroringIcons: IconSet = { component: SvgIcon };
