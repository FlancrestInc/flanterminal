import { createRoot } from 'react-dom/client';

import { AuthenticatedRoot } from './AuthenticatedRoot.js';
import './theme.css';

const container = document.querySelector<HTMLDivElement>('#root');
if (container === null) throw new Error('Missing application root');

const root = createRoot(container);
root.render(<AuthenticatedRoot />);
