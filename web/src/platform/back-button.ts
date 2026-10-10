/** What the system back button can act on, top first. */
export interface BackTargets {
  /** Closes the open temporary drawer; false when none is open. */
  closeDrawer: () => boolean;
  /** Goes back in the app's history; false at its start. */
  goBack: () => boolean;
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
