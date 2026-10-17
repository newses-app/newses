// Identifies a Newses server to the desktop and mobile apps (no Zod, so browsers can import it).

export const PRODUCT_NAME = 'newses';
/** Earlier names of the product that servers not yet updated still report. */
export const LEGACY_PRODUCT_NAMES: readonly string[] = ['rss-reader'];

/** Revision of `/api/v1`: a new major breaks existing apps; a new minor adds what apps may require. */
export const API_VERSION = { major: 1, minor: 3 } as const;
