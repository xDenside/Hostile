import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followVisibleHeight } from '../src/lib/visible-height';

function fakeView(height: number) {
  const target = new EventTarget();
  return Object.assign(target, { height, scale: 1, offsetTop: 0 }) as unknown as VisualViewport & {
    height: number;
    scale: number;
    offsetTop: number;
  };
}

const fakeRoot = () => {
  const values = new Map<string, string>();
  return {
    style: {
      setProperty: (name: string, value: string) => values.set(name, value),
      removeProperty: (name: string) => values.delete(name),
    },
    read: () => values.get('--visible-height'),
  };
};

describe('followVisibleHeight', () => {
  let scrollTo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollTo = vi.fn();
    vi.stubGlobal('window', { scrollTo, scrollY: 0 });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('takes the height that can be seen, and follows it as a keyboard comes and goes', () => {
    const view = fakeView(800);
    const root = fakeRoot();
    followVisibleHeight(view, root as unknown as HTMLElement);
    expect(root.read()).toBe('800px');

    view.height = 460;
    view.dispatchEvent(new Event('resize'));
    expect(root.read()).toBe('460px');

    view.height = 800;
    view.dispatchEvent(new Event('resize'));
    expect(root.read()).toBe('800px');
  });

  it('puts back a page the browser slid up, and leaves one that has not moved alone', () => {
    const view = fakeView(460);
    followVisibleHeight(view, fakeRoot() as unknown as HTMLElement);
    expect(scrollTo).not.toHaveBeenCalled();

    view.offsetTop = 300;
    view.dispatchEvent(new Event('scroll'));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('does not shrink the page to what a pinch shows', () => {
    const view = fakeView(800);
    const root = fakeRoot();
    followVisibleHeight(view, root as unknown as HTMLElement);

    view.scale = 2;
    view.height = 400;
    view.offsetTop = 120;
    view.dispatchEvent(new Event('resize'));
    expect(root.read()).toBeUndefined();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('lets go when stopped', () => {
    const view = fakeView(800);
    const root = fakeRoot();
    const stop = followVisibleHeight(view, root as unknown as HTMLElement);
    stop();
    expect(root.read()).toBeUndefined();
    view.height = 300;
    view.dispatchEvent(new Event('resize'));
    expect(root.read()).toBeUndefined();
  });
});
