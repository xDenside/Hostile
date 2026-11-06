export function followVisibleHeight(view: VisualViewport, root: HTMLElement): () => void {
  const sync = () => {
    if (view.scale > 1.01) {
      root.style.removeProperty('--visible-height');
      return;
    }
    root.style.setProperty('--visible-height', `${view.height}px`);
    if (view.offsetTop !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };
  view.addEventListener('resize', sync);
  view.addEventListener('scroll', sync);
  sync();
  return () => {
    view.removeEventListener('resize', sync);
    view.removeEventListener('scroll', sync);
    root.style.removeProperty('--visible-height');
  };
}
