import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { AppServicesProvider } from './app/AppServicesContext';
import { createAppServices } from './app/bootstrap';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点');
}

const services = createAppServices();

createRoot(container).render(
  <StrictMode>
    <AppServicesProvider services={services}>
      <App />
    </AppServicesProvider>
  </StrictMode>,
);
