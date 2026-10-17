import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { registerSW } from 'virtual:pwa-register';
import App from './App.vue';
import { i18n } from './plugins/i18n.ts';
import { queryClient } from './plugins/query.ts';
import { createAppVuetify } from './plugins/vuetify.ts';
import { startAppearance } from './composables/useAppearance.ts';
import { installAuthGuard } from './composables/useSession.ts';
import { api } from './api.ts';
import { startConnectivity } from './offline/connectivity.ts';
import { mirrorQueries } from './offline/snapshot.ts';
import { currentStore } from './offline/store.ts';
import { bridge, connection, NATIVE } from './platform/index.ts';
import { handleBack } from './platform/back-button.ts';
import { routeExternalLinks } from './platform/external-links.ts';
import { router } from './router.ts';
import { useUiStore } from './stores/ui.ts';
import './styles.css';
import './themes/fonts.css';
import './themes/terminal.css';
import './themes/sketch.css';

document.documentElement.dataset.platform = bridge.platform;
// The last theme shown here, so a reload doesn't flash Original and signed-out screens are themed.
const appearance = startAppearance();
// The apps' server and token come from the shell before the first navigation needs them.
await connection.load();
// Whether the device has a network, before the first request.
await startConnectivity(bridge, () => api.serverInfo());
if (NATIVE) routeExternalLinks(document, (url) => void bridge.openExternal(url));
installAuthGuard(router, queryClient);
// What the app needs to start offline, kept as it loads.
mirrorQueries(queryClient, currentStore);

const pinia = createPinia();
createApp(App)
  .use(pinia)
  .use(router)
  .use(createAppVuetify(appearance))
  .use(i18n)
  .use(VueQueryPlugin, { queryClient })
  .mount('#app');

const ui = useUiStore(pinia);
bridge.onBackButton(() =>
  handleBack(document, {
    // Only the narrow layout's drawer covers the page; the wide one stays open.
    closeDrawer: () => {
      if (!document.querySelector('.v-navigation-drawer--temporary.v-navigation-drawer--active')) {
        return false;
      }
      ui.drawer = false;
      return true;
    },
    goBack: () => {
      if (!router.options.history.state.back) return false;
      router.back();
      return true;
    },
  }),
);

// A clicked notification opens its feed or category.
bridge.onNavigate((target) => void router.push(target));

// A no-op in the native build, which has no service worker.
registerSW({ immediate: true });
