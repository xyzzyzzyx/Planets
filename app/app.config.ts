import {
  ApplicationConfig,
  InjectionToken,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { environment } from './environments/environment';
import { routes } from './app.routes';

/** Backend endpoints. */
export interface AppConfig {
  /** WebSocket URL for the simulation protocol (absolute `wss://` or a path proxied by the dev server). */
  wsUrl: string;
  /** Server-Sent Events URL for the initial universe snapshot. */
  sseUrl: string;
}

export const APP_CONFIG = new InjectionToken<AppConfig>('app.config', {
  providedIn: 'root',
  factory: () => ({ wsUrl: environment.wsUrl, sseUrl: environment.sseUrl }),
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
  ],
};
