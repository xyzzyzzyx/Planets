import { TestBed } from '@angular/core/testing';
import { APP_CONFIG } from '../app.config';
import { FakeEventSource } from '../testing/fakes';
import { SseService } from './sse.service';

describe('SseService', () => {
  let service: SseService;
  const source = () => FakeEventSource.instances.at(-1)!;

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', Object.assign(FakeEventSource, { CLOSED: 2 }));
    TestBed.configureTestingModule({ providers: [{ provide: APP_CONFIG, useValue: { wsUrl: '/ws', sseUrl: '/event' } }] });
    service = TestBed.inject(SseService);
    service.sourceFactory = (url) => new FakeEventSource(url) as unknown as EventSource;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('connects once, lazily, to the configured URL', () => {
    expect(FakeEventSource.instances).toHaveLength(0);
    service.on('planets').subscribe();
    service.on('update').subscribe();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source().url).toBe('/event');
  });

  it('parses JSON payloads and replays the latest planets snapshot to late subscribers', () => {
    const early: unknown[] = [];
    service.on('planets').subscribe((v) => early.push(v));
    source().emit('planets', { planets: [1] });
    const late: unknown[] = [];
    service.on('planets').subscribe((v) => late.push(v));
    expect(early).toEqual([{ planets: [1] }]);
    expect(late).toEqual([{ planets: [1] }]);
  });

  it('does not replay plain update events and passes non-JSON through as text', () => {
    service.on('update').subscribe();
    source().emit('update', 'not json');
    const seen: unknown[] = [];
    service.on('update').subscribe((v) => seen.push(v));
    expect(seen).toEqual([]);
    source().emit('update', 'still not json');
    expect(seen).toEqual(['still not json']);
  });

  it('tracks connection state', () => {
    service.on('planets').subscribe();
    source().onopen?.(new Event('open'));
    expect(service.connected()).toBe(true);
    source().fail();
    expect(service.connected()).toBe(false);
  });

  it('errors subscribers when the stream closes permanently', () => {
    const errors: unknown[] = [];
    service.on('planets').subscribe({ error: (e) => errors.push(e) });
    source().fail(true);
    expect(errors).toHaveLength(1);
  });

  it('close() shuts the stream and completes subscribers', () => {
    let done = false;
    service.on('planets').subscribe({ complete: () => (done = true) });
    const s = source();
    service.close();
    expect(s.closed).toBe(true);
    expect(done).toBe(true);
    expect(service.connected()).toBe(false);
  });
});
