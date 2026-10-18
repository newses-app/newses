// The desktop app has no native title bar: its window controls overlay the app bar's end.

/** Chromium's Window Controls Overlay, which TypeScript's DOM library leaves out. */
export interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
}

const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay })
  .windowControlsOverlay;

/**
 * Keeps `data-window-controls` on the root while the overlay shows (not in full screen), so the
 * app bar moves the window and leaves room for the controls. Browsers and Android never set it.
 */
export function trackWindowControls(root: HTMLElement, controls = overlay): void {
  if (!controls) return;
  const update = () => {
    root.toggleAttribute('data-window-controls', controls.visible);
  };
  controls.addEventListener('geometrychange', update);
  update();
}
