import { createRoot } from 'react-dom/client';

import { App, StartupState } from './App.js';
import { loadClientConfig } from './config.js';
import './theme.css';

const container = document.querySelector<HTMLDivElement>('#root');
if (container === null) throw new Error('Missing application root');

const root = createRoot(container);
const controller = new AbortController();
window.addEventListener('pagehide', () => controller.abort(), { once: true });

root.render(<StartupState state="loading" />);

void loadClientConfig({ signal: controller.signal })
  .then((config) => root.render(<App config={config} />))
  .catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    root.render(<StartupState state="error" />);
  });
