import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeExternalLinks } from './external-links.ts';

let stop: () => void = () => undefined;
afterEach(() => {
  stop();
  document.body.innerHTML = '';
});

function click(html: string, init: MouseEventInit = {}, type = 'click') {
  document.body.innerHTML = html;
  const open = vi.fn();
  stop = routeExternalLinks(document, open);
  const target = document.querySelector('[data-target]') ?? document.body;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return { open, prevented: event.defaultPrevented };
}

describe('routeExternalLinks', () => {
  it('opens links to other origins in the system browser', () => {
    const { open, prevented } = click(
      '<a href="https://site.example/post"><span data-target>Read</span></a>',
    );
    expect(open).toHaveBeenCalledWith('https://site.example/post');
    expect(prevented).toBe(true);
  });

  it('opens middle clicks too', () => {
    const { open } = click(
      '<a data-target href="https://site.example/">x</a>',
      { button: 1 },
      'auxclick',
    );
    expect(open).toHaveBeenCalledWith('https://site.example/');
  });

  it('leaves in-app links to the router', () => {
    const { open, prevented } = click('<a data-target href="/settings">Settings</a>');
    expect(open).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it('blocks other schemes without opening them', () => {
    const { open, prevented } = click('<a data-target href="mailto:a@example.com">Mail</a>');
    expect(open).not.toHaveBeenCalled();
    expect(prevented).toBe(true);
  });
});
