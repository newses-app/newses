import type { InstalledPlugin } from './registry.ts';

/**
 * The plugins this build runs: none from the repository itself. Imported as `#installed-plugins`,
 * which a deployment's build points at the list `install.ts` writes.
 */
export const INSTALLED_PLUGINS: readonly InstalledPlugin[] = [];
