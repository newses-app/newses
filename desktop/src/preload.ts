// Exposes the platform bridge (renderer-bridge.ts) to the web app.
import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopBridge } from './renderer-bridge.ts';

// The preload runs in the window, but is typed with the main process's libraries, which have no DOM.
declare const navigator: { readonly onLine: boolean };
declare const window: {
  addEventListener(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener(type: 'online' | 'offline', listener: () => void): void;
};

contextBridge.exposeInMainWorld(
  'rssReaderBridge',
  createDesktopBridge(ipcRenderer, { argv: process.argv, navigator, window }),
);
