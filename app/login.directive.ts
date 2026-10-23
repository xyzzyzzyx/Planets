import { Directive, inject } from '@angular/core';
import { LoginService } from './login.service';

/** Toggles the login overlay when the host element is clicked. */
@Directive({
  selector: '[loginClick]',
  host: {
    '(click)': 'onClick()',
    '[attr.aria-pressed]': 'loginService.showing()',
  },
})
export class LoginDirective {
  protected readonly loginService = inject(LoginService);

  onClick(): void {
    this.loginService.toggle();
  }
}
