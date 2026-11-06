import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist/wght.css';
import './styles/global.scss';
import { App } from './App';
import { installUploadGuard } from './features/chat/upload-guard';
import { installDropGuard } from './lib/drop-guard';
import { followVisibleHeight } from './lib/visible-height';
import { initPlatform } from './platform';

installDropGuard();
if (window.visualViewport && window.matchMedia('(pointer: coarse)').matches) {
  followVisibleHeight(window.visualViewport, document.documentElement);
}

async function start() {
  const p = await initPlatform();
  if (p.kind === 'desktop') {
    const info = await p.desktop!.getInfo();
    document.documentElement.dataset.platform =
      info.platform === 'darwin' ? 'desktop-mac' : 'desktop';
  } else {
    installUploadGuard();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
