import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { registerSW } from 'virtual:pwa-register';
import App from './App.vue';
import { i18n } from './plugins/i18n.ts';
import { queryClient } from './plugins/query.ts';
import { vuetify } from './plugins/vuetify.ts';
import { installAuthGuard } from './composables/useSession.ts';
import { router } from './router.ts';
import './styles.css';

installAuthGuard(router, queryClient);

createApp(App)
  .use(createPinia())
  .use(router)
  .use(vuetify)
  .use(i18n)
  .use(VueQueryPlugin, { queryClient })
  .mount('#app');

registerSW({ immediate: true });
