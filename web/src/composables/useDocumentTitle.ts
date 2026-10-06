import { watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';

/** Names the browser tab, and so the page screen readers announce, after the current view. */
export function useDocumentTitle(title: () => string | undefined): void {
  const { t } = useI18n();
  watchEffect(() => {
    const view = title();
    document.title = view ? `${view} – ${t('app.name')}` : t('app.name');
  });
}
