import { createContext, useContext, type ReactNode } from 'react';

import type { AppServices } from './bootstrap';

const AppServicesContext = createContext<AppServices | null>(null);

export function AppServicesProvider(props: {
  services: AppServices;
  children: ReactNode;
}) {
  return (
    <AppServicesContext.Provider value={props.services}>
      {props.children}
    </AppServicesContext.Provider>
  );
}

export function useAppServices(): AppServices {
  const services = useContext(AppServicesContext);
  if (!services) {
    throw new Error('useAppServices 必须在 AppServicesProvider 内部使用');
  }
  return services;
}
