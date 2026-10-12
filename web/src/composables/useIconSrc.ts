import type { Subscription } from '@newses/shared';
import { iconSrc } from '../lib/native-urls.ts';
import { appServer } from '../platform/index.ts';
import { useSession } from './useSession.ts';

/** Where to load subscriptions' icons from, here: see `iconSrc`. */
export function useIconSrc() {
  const { session } = useSession();
  return (subscription: Pick<Subscription, 'id' | 'iconUrl'>) =>
    iconSrc(subscription, session.value?.iconsPath, appServer());
}
