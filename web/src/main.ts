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
import { routeExternalLinks } from './platform/external-links.ts';
import { router } from './router.ts';
import './styles.css';

// The apps' server and token come from the shell before the first navigation needs them.
await connection.load();
if (NATIVE) routeExternalLinks(document, (url) => void bridge.openExternal(url));
installAuthGuard(router, queryClient);

createApp(App)
  .use(createPinia())
  .use(router)
  .use(vuetify)
  .use(i18n)
  .use(VueQueryPlugin, { queryClient })
  .mount('#app');

// A no-op in the native build, which has no service worker.
registerSW({ immediate: true });
