/**
 * Production build served by `node server.js` on https://localhost:3000.
 * `:3001` means "same host, port 3001" (resolved at runtime by resolveWebSocketUrl).
 */
export const environment = {
  production: true,
  wsUrl: ':3001',
  sseUrl: '/event',
};
