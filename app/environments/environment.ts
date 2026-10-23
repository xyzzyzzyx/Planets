/** Development: the Angular dev server proxies /ws and /event to the backend (see proxy.conf.json). */
export const environment = {
  /** Swapped for environment.prod.ts by the production build (angular.json fileReplacements). */
  production: false,
  wsUrl: '/ws',
  sseUrl: '/event',
};
