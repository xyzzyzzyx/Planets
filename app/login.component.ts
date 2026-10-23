import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LoginService } from './login.service';

export interface Credentials { email: string; password: string; }

@Component({
  selector: 'login',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onCancel()' },
  styles: [`
    .login-overlay {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.85);
      z-index: 3000;
      display: flex; justify-content: center; align-items: center;
    }
    .login-card {
      background: #1a1a1a; padding: 2.5rem; border-radius: 12px; border: 1px solid #333;
      color: white; width: 100%; max-width: 420px; box-shadow: 0 20px 50px rgba(0,0,0,0.8);
    }
    .social-header { text-align: center; margin-bottom: 1rem; font-size: 0.9rem; color: #888; }
    .social-links { display: flex; gap: 10px; justify-content: center; margin-bottom: 2rem; }
    .form-label { color: #aaa; font-size: 0.85rem; }
    .form-control { background-color: #2a2a2a !important; border-color: #444 !important; color: white !important; }
    .form-control::placeholder { color: #666; }
  `],
  template: `
    @if (loginService.showing()) {
      <div class="login-overlay" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <div class="login-card">
          <h4 id="login-title" class="mb-4 text-center">Sign In</h4>

          <div class="social-header">Login with Social</div>
          <div class="social-links">
            @for (p of providers; track p.id) {
              <a [href]="'/auth/' + p.id" class="btn btn-outline-secondary btn-sm" [attr.aria-label]="'Sign in with ' + p.label">
                <i class="bi" [class]="'bi-' + p.icon"></i>
              </a>
            }
          </div>

          <form (ngSubmit)="onSubmit()" #form="ngForm">
            <div class="mb-3">
              <label class="form-label" for="login-email">Email Address</label>
              <input id="login-email" name="email" type="email" class="form-control" placeholder="name@example.com"
                     autocomplete="username" required email [(ngModel)]="credentials.email">
            </div>
            <div class="mb-4">
              <label class="form-label" for="login-password">Password</label>
              <input id="login-password" name="password" type="password" class="form-control" placeholder="••••••••"
                     autocomplete="current-password" required [(ngModel)]="credentials.password">
            </div>
            <div class="d-grid gap-2">
              <button type="submit" class="btn btn-primary" [disabled]="form.invalid">Log In</button>
              <button type="button" class="btn btn-link text-warning" (click)="onCancel()">Cancel</button>
            </div>
          </form>
        </div>
      </div>
    }
  `,
})
/**
 * Sign-in overlay (UI only: there is no authentication backend yet, so submit
 * just closes it and the password is discarded immediately).
 */
export class LoginComponent {
  protected readonly loginService = inject(LoginService);

  protected readonly providers = [
    { id: 'google', label: 'Google', icon: 'google' },
    { id: 'linkedin', label: 'LinkedIn', icon: 'linkedin' },
    { id: 'github', label: 'GitHub', icon: 'github' },
    { id: 'microsoft', label: 'Microsoft', icon: 'microsoft' },
    { id: 'twitter', label: 'X', icon: 'twitter-x' },
  ] as const;

  credentials: Credentials = { email: '', password: '' };

  onSubmit(): void {
    // Authentication backend not implemented yet; never keep the password around.
    this.credentials = { email: this.credentials.email, password: '' };
    this.loginService.setShowing(false);
  }

  onCancel(): void {
    this.credentials = { email: '', password: '' };
    this.loginService.setShowing(false);
  }
}
