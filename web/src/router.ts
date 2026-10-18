import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router';
import { publishDraftFrom, sharedLinkFrom, subscribeUrlFrom } from './lib/intents.ts';
import { STREAM_PATTERN } from './lib/streams.ts';
import { shares } from './platform/index.ts';
import { useUiStore } from './stores/ui.ts';

/**
 * An address that opens a dialog filled in (see `lib/intents.ts`): reached once signed in, it
 * hands its query to `open` and goes on to All articles, where the dialog shows.
 */
const intent = (path: string, open: (to: RouteLocationNormalized) => void) => ({
  path,
  component: { render: () => null },
  beforeEnter: (to: RouteLocationNormalized) => {
    open(to);
    return { path: '/all', replace: true };
  },
});

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/connect',
      name: 'connect',
      component: () => import('./views/ConnectView.vue'),
      meta: { public: true },
    },
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
        intent('publish', ({ query }) => {
          const draft = publishDraftFrom(query);
          if (!draft) return;
          const ui = useUiStore();
          // A bookmarklet's window closes once the page is published.
          ui.publishDraft = { ...draft, closeWindow: window.opener !== null };
          ui.publishOpen = true;
        }),
        intent('subscribe', ({ query }) => {
          const url = subscribeUrlFrom(query);
          if (!url) return;
          const ui = useUiStore();
          ui.subscribeUrl = url;
          ui.subscribeOpen = true;
        }),
        intent('share', ({ query }) => {
          const link = sharedLinkFrom(query);
          if (link) shares.offer(link);
        }),
        {
          path: 'settings/:tab(preferences|appearance|shortcuts|feeds|labels|filters|sharing|offline|account|users|operations)?',
          name: 'settings',
          component: () => import('./views/SettingsView.vue'),
        },
        {
          path: ':stream(all|f\\d+)/archive/:key?',
          name: 'archive',
          component: () => import('./views/ArchiveView.vue'),
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
