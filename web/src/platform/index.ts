import { selectBridge } from './bridge.ts';
import { createConnection } from './connection.ts';
import { createUpdates } from './updates.ts';

/** The desktop and mobile apps' build (`vite build --mode native`). */
export const NATIVE = import.meta.env.MODE === 'native';

export const bridge = selectBridge(window.rssReaderBridge, NATIVE);

export const connection = createConnection(bridge);

export const updates = createUpdates(bridge);

/** The server's origin when the app runs on another one (the apps); null in the browser. */
export const appServer = (): string | null => (NATIVE ? connection.state.serverUrl : null);

/** Origin of the server's public pages and feeds. */
export const serverOrigin = (): string => appServer() ?? location.origin;
