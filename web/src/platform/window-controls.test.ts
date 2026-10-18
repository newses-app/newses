import { describe, expect, it } from 'vitest';
import { trackWindowControls, type WindowControlsOverlay } from './window-controls.ts';

const overlay = (visible: boolean) =>
  Object.assign(new EventTarget(), { visible }) as WindowControlsOverlay & { visible: boolean };

describe('trackWindowControls', () => {
  it('marks the root while the overlay shows, and follows it', () => {
    const root = document.createElement('html');
    const controls = overlay(true);
    trackWindowControls(root, controls);
    expect(root.hasAttribute('data-window-controls')).toBe(true);
    controls.visible = false;
    controls.dispatchEvent(new Event('geometrychange'));
    expect(root.hasAttribute('data-window-controls')).toBe(false);
  });

  it('leaves the root alone without an overlay', () => {
    const root = document.createElement('html');
    trackWindowControls(root, undefined);
    expect(root.hasAttribute('data-window-controls')).toBe(false);
  });
});
