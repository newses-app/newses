import { createRouter, createWebHistory } from 'vue-router';
import { STREAM_PATTERN } from './lib/streams.ts';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/change-password',
      name: 'change-password',
      component: () => import('./views/ChangePasswordView.vue'),
    },
    {
      path: '/',
      component: () => import('./views/SignedInLayout.vue'),
      children: [
        { path: '', redirect: '/all' },
        {
          path: 'settings/:tab(preferences|shortcuts|feeds|labels|sharing|account|users)?',
          name: 'settings',
          component: () => import('./views/SettingsView.vue'),
        },
        {
          path: `:stream(${STREAM_PATTERN})/:entry(\\d+)?`,
          name: 'reader',
          component: () => import('./views/ReaderView.vue'),
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/all' },
  ],
});
