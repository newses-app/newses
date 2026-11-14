// Connectivity a test sets, in place of the one requests drive:
// vi.mock('../offline/connectivity.ts', async (importOriginal) => ({
//   ...(await importOriginal<object>()),
//   ...(await import('../test/connectivity.ts')),
// }));
import type { NetworkStatus } from '@newses/shared';
import { ref } from 'vue';
import type { Connectivity } from '../lib/connectivity.ts';

export const connectivity = ref<Connectivity>('online');
export const networkStatus = ref<NetworkStatus>({ connected: true, wifi: null });
