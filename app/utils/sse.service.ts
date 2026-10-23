import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Observable, ReplaySubject, Subject } from 'rxjs';
import { APP_CONFIG } from '../app.config';

/** Events the backend emits on the SSE stream. */
export type SseEventName = 'planets' | 'update';

/** Factory seam so tests can substitute a fake EventSource. */
export const createEventSource = (url: string): EventSource => new EventSource(url);

@Injectable({ providedIn: 'root' })
export class SseService {
  private readonly config = inject(APP_CONFIG);
  private eventSource: EventSource | null = null;
  private readonly subjects = new Map<SseEventName, Subject<unknown>>();

  /** Factory used to open the stream; overridable in tests. */
  sourceFactory: (url: string) => EventSource = createEventSource;

  readonly connected = signal(false);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.close());
  }

  /** Subscribe to an event; connects lazily. `planets` replays the latest snapshot to late subscribers. */
  on<T = unknown>(eventName: SseEventName): Observable<T> {
    const subject = this.getSubject(eventName);
    this.connect();
    return subject.asObservable() as Observable<T>;
  }

  private connect(): void {
    if (this.eventSource) return;
    const source = this.sourceFactory(this.config.sseUrl);
    this.eventSource = source;
    source.onopen = () => this.connected.set(true);
    source.onerror = () => {
      this.connected.set(false);
      // The browser retries automatically unless the stream was closed for good.
      if (source.readyState === EventSource.CLOSED) {
        for (const s of this.subjects.values()) s.error(new Error('SSE connection closed'));
      }
    };
    for (const name of ['planets', 'update'] as const) {
      source.addEventListener(name, (e: Event) => {
        const data = (e as MessageEvent<string>).data;
        let value: unknown = data;
        try { value = JSON.parse(data); } catch { /* deliver raw text */ }
        this.getSubject(name).next(value);
      });
    }
  }

  private getSubject(name: SseEventName): Subject<unknown> {
    let subject = this.subjects.get(name);
    if (!subject) {
      subject = name === 'planets' ? new ReplaySubject<unknown>(1) : new Subject<unknown>();
      this.subjects.set(name, subject);
    }
    return subject;
  }

  close(): void {
    this.eventSource?.close();
    this.eventSource = null;
    this.connected.set(false);
    for (const s of this.subjects.values()) s.complete();
    this.subjects.clear();
  }
}
