import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { AppServicesProvider } from './app/AppServicesContext';
import { WorkbenchPrototype } from './app/WorkbenchPrototype';
import { createAppServices } from './app/bootstrap';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点');
}

const showWorkbenchPrototype =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get('prototype') === 'workbench';
const services = showWorkbenchPrototype ? null : createAppServices();

createRoot(container).render(
  <StrictMode>
    {showWorkbenchPrototype ? (
      <WorkbenchPrototype />
    ) : (
      <AppServicesProvider services={services!}>
        <App />
      </AppServicesProvider>
    )}
  </StrictMode>,
);
