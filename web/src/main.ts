import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { registerSW } from 'virtual:pwa-register';
import App from './App.vue';
import { i18n } from './plugins/i18n.ts';
import { queryClient } from './plugins/query.ts';
import { vuetify } from './plugins/vuetify.ts';
import { installAuthGuard } from './composables/useSession.ts';
import { bridge, connection, NATIVE } from './platform/index.ts';
import { handleBack } from './platform/back-button.ts';
import { routeExternalLinks } from './platform/external-links.ts';
import { router } from './router.ts';
import { useUiStore } from './stores/ui.ts';
import './styles.css';

document.documentElement.dataset.platform = bridge.platform;
// The apps' server and token come from the shell before the first navigation needs them.
await connection.load();
if (NATIVE) routeExternalLinks(document, (url) => void bridge.openExternal(url));
installAuthGuard(router, queryClient);

const pinia = createPinia();
createApp(App)
  .use(pinia)
  .use(router)
  .use(vuetify)
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

// A no-op in the native build, which has no service worker.
registerSW({ immediate: true });
