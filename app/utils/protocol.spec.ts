import { parseServerMessage, resolveWebSocketUrl } from './protocol';

describe('parseServerMessage', () => {
  it.each(['orbitSync', 'orbitUpdate', 'planetsData', 'universeTransition', 'error'])('accepts %s frames', (type) => {
    expect(parseServerMessage(JSON.stringify({ type, x: 1 }))).toEqual({ type, x: 1 });
  });

  it.each([
    ['unknown type', JSON.stringify({ type: 'hack' })],
    ['missing type', JSON.stringify({ a: 1 })],
    ['malformed JSON', '{nope'],
    ['JSON null', 'null'],
    ['non-string payload', new ArrayBuffer(4)],
    ['numeric type', JSON.stringify({ type: 5 })],
  ])('rejects %s', (_label, raw) => {
    expect(parseServerMessage(raw)).toBeNull();
  });
});

describe('resolveWebSocketUrl', () => {
  const https = { protocol: 'https:', host: 'example.com:4200', hostname: 'example.com' };
  const http = { protocol: 'http:', host: 'localhost:4200', hostname: 'localhost' };

  it('keeps absolute ws/wss URLs', () => {
    expect(resolveWebSocketUrl('wss://a.b:1/x', https)).toBe('wss://a.b:1/x');
    expect(resolveWebSocketUrl('ws://a.b', https)).toBe('ws://a.b');
  });

  it('resolves paths against the page host with a matching scheme', () => {
    expect(resolveWebSocketUrl('/ws', https)).toBe('wss://example.com:4200/ws');
    expect(resolveWebSocketUrl('ws', http)).toBe('ws://localhost:4200/ws');
  });

  it('resolves ":port" to the same hostname on another port', () => {
    expect(resolveWebSocketUrl(':3001', https)).toBe('wss://example.com:3001');
  });
});
