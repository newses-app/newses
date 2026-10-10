// Identifies an rss-reader server to the desktop and mobile apps (no Zod, so browsers can import it).

export const PRODUCT_NAME = 'rss-reader';

/** Revision of `/api/v1`: a new major breaks existing apps; a new minor adds what apps may require. */
export const API_VERSION = { major: 1, minor: 0 } as const;
