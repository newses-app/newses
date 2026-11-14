import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serveApp } from './serve.ts';
import { net, resetElectron } from './test/electron.ts';

vi.mock('electron', () => import('./test/electron.ts'));

const WEB_DIR = '/opt/Newses/resources/web';
const CSP = "default-src 'self'";

beforeEach(() => {
  resetElectron();
});

describe('serveApp', () => {
  it('serves bundled files with the CSP, and routes as the app page', async () => {
    net.fetch.mockResolvedValue(
      new Response('body', { status: 200, headers: { 'content-type': 'text/javascript' } }),
    );
    const serve = serveApp({ webDir: WEB_DIR, csp: CSP });
    const response = await serve(new Request('app://newses/assets/app.js'));
    expect(net.fetch).toHaveBeenLastCalledWith(pathToFileURL(`${WEB_DIR}/assets/app.js`).href);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'text/javascript',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
    });
    expect(await response.text()).toBe('body');

    await serve(new Request('app://newses/settings/feeds'));
    expect(net.fetch).toHaveBeenLastCalledWith(pathToFileURL(`${WEB_DIR}/index.html`).href);
  });

  it('answers 404 for other hosts and files that cannot be read', async () => {
    const serve = serveApp({ webDir: WEB_DIR, csp: CSP });
    expect((await serve(new Request('app://other/app.js'))).status).toBe(404);
    expect(net.fetch).not.toHaveBeenCalled();
    net.fetch.mockRejectedValueOnce(new Error('ENOENT'));
    expect((await serve(new Request('app://newses/missing.js'))).status).toBe(404);
  });

  it("forwards everything to the web app's dev server in development", async () => {
    const serve = serveApp({ webDir: WEB_DIR, csp: CSP, devServer: 'http://localhost:5173' });
    await serve(new Request('app://newses/all?unread=1'));
    expect(net.fetch).toHaveBeenCalledWith('http://localhost:5173/all?unread=1');
  });
});
