import { Injectable, signal } from '@angular/core';

/** Shared shell layout state (e.g. full-screen views hiding the navbar). */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly _navbarHidden = signal(false);
  readonly navbarHidden = this._navbarHidden.asReadonly();

  setNavbarHidden(hidden: boolean): void {
    this._navbarHidden.set(hidden);
  }

  toggleNavbar(): void {
    this._navbarHidden.update((hidden) => !hidden);
  }
}
