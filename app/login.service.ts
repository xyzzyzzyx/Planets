import { Injectable, signal } from '@angular/core';

/** Visibility of the sign-in overlay. */
@Injectable({ providedIn: 'root' })
export class LoginService {
  private readonly _showing = signal(false);
  readonly showing = this._showing.asReadonly();

  setShowing(showing: boolean): void {
    this._showing.set(showing);
  }

  toggle(): void {
    this._showing.update((s) => !s);
  }
}
