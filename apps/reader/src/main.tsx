import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { AppServicesProvider } from './app/AppServicesContext';
import { WorkbenchPrototype } from './app/WorkbenchPrototype';
import { createAppServices, type AppServices } from './app/bootstrap';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点');
}

const showWorkbenchPrototype =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get('prototype') === 'workbench';
const runtimeCacheHarness =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get('runtime-cache-harness') === '1';
const root = createRoot(container);

/**
 * 渲染应用入口。真实浏览器验收需要在已加载的页面内注入一套测试服务；
 * 重新渲染同一个根节点可以让 React 组件、Command 和 Repository 始终属于
 * 同一套 AppServices,避免验收脚本另建服务后与旧组件交叉竞态。
 */
export function renderApplication(
  services: AppServices | null,
  onReady?: () => void,
): void {
  root.render(
    <StrictMode>
      {showWorkbenchPrototype ? (
        <WorkbenchPrototype />
      ) : !services ? (
        <div data-runtime-cache-harness-placeholder="true" />
      ) : (
        <AppServicesProvider services={services}>
          <App
            {...(onReady ? { onReady, skipStartupRestore: true } : {})}
          />
        </AppServicesProvider>
      )}
    </StrictMode>,
  );
}

const services = showWorkbenchPrototype || runtimeCacheHarness ? null : createAppServices();
renderApplication(services);
