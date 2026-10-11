import type { DesktopOptions } from '@rss-reader/shared';
import { readonly, ref } from 'vue';
import type { PlatformBridge } from './bridge.ts';

/** The desktop app's options (notifications, tray, launch at login); null elsewhere. */
export function createDesktopOptions(bridge: PlatformBridge) {
  const options = ref<DesktopOptions | null>(null);
  void bridge.getDesktopOptions().then((loaded) => {
    options.value = loaded;
  });
  return {
    options: readonly(options),
    async set(changes: Partial<DesktopOptions>) {
      await bridge.setDesktopOptions(changes);
      if (options.value) options.value = { ...options.value, ...changes };
    },
  };
}
