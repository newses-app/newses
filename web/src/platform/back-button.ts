import type { Router } from 'vue-router';

/** What the system back button can act on, top first. */
export interface BackTargets {
  /** Closes the open temporary drawer; false when none is open. */
  closeDrawer: () => boolean;
  /** Goes back in the app's history; false at its start. */
  goBack: () => boolean;
}

/**
 * The app's targets: the drawer only in the narrow layout, where it covers the page (the wide one
 * stays open), then the router's history.
 */
export function appBackTargets(
  doc: Document,
  ui: { drawer: boolean | null },
  router: Pick<Router, 'back' | 'options'>,
): BackTargets {
  return {
    closeDrawer: () => {
      if (!doc.querySelector('.v-navigation-drawer--temporary.v-navigation-drawer--active')) {
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
  };
}

/** Dialogs and menus close on Escape; snackbars and tooltips are not dismissed by back. */
const CLOSABLE_OVERLAY = '.v-dialog.v-overlay--active, .v-menu.v-overlay--active';

/**
 * The system back button: closes the topmost dialog or menu, then the drawer, then goes back.
 * False when there was nothing to do, so the app may exit.
 */
export function handleBack(doc: Document, targets: BackTargets): boolean {
  if (doc.querySelector(CLOSABLE_OVERLAY)) {
    const target = doc.activeElement ?? doc.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  }
  return targets.closeDrawer() || targets.goBack();
}
