// `pnpm dev`: the web app's Vite dev server in native mode, and Electron serving it on the app
// origin (so CORS and the bridge behave as in the packaged app), with hot reload.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEV_SERVER = 'http://localhost:5173';
const root = fileURLToPath(new URL('..', import.meta.url));
const shell = process.platform === 'win32';

const built = spawnSync('node', ['scripts/build.ts', '--skip-web'], {
  cwd: root,
  stdio: 'inherit',
});
if (built.status !== 0) process.exit(built.status ?? 1);

const children: ChildProcess[] = [];
const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

children.push(
  spawn(
    'pnpm',
    ['--filter', '@rss-reader/web', 'exec', 'vite', '--mode', 'native', '--strictPort'],
    {
      stdio: 'inherit',
      shell,
    },
  ),
);

async function waitForServer(): Promise<void> {
  for (;;) {
    try {
      await fetch(DEV_SERVER);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

await waitForServer();
const electron = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: root,
  stdio: 'inherit',
  shell,
  // Editors built on Electron (VS Code) set ELECTRON_RUN_AS_NODE for their terminals' tools.
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, RSS_READER_DEV_SERVER: DEV_SERVER },
});
children.push(electron);
electron.on('close', stop);
