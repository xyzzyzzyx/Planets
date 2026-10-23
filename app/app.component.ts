import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LayoutService } from './layout.service';
import { LoginComponent } from './login.component';
import { LoginDirective } from './login.directive';

interface NavLink { path: string; label: string; }

@Component({
  selector: 'ts-app',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, LoginComponent, LoginDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .navbar {
      transition: margin-top 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 1050;
    }
    .navbar-hidden {
      margin-top: -56px !important;
      box-shadow: none;
    }
  `],
  template: `
    <nav class="navbar navbar-expand-lg navbar-dark bg-dark" [class.navbar-hidden]="layout.navbarHidden()">
      <div class="container-fluid">
        <a class="navbar-brand" routerLink="/home">Planets</a>
        <button class="navbar-toggler" type="button" aria-controls="navNav" aria-label="Toggle navigation"
                [attr.aria-expanded]="menuOpen()" (click)="menuOpen.set(!menuOpen())">
          <span class="navbar-toggler-icon"></span>
        </button>
        <div class="collapse navbar-collapse" id="navNav" [class.show]="menuOpen()">
          <ul class="navbar-nav me-auto">
            @for (link of links; track link.path) {
              <li class="nav-item">
                <a class="nav-link" [routerLink]="link.path" routerLinkActive="active" ariaCurrentWhenActive="page"
                   (click)="menuOpen.set(false)">{{ link.label }}</a>
              </li>
            }
          </ul>
          <ul class="navbar-nav">
            <li class="nav-item"><a class="nav-link" routerLink="/register" routerLinkActive="active">Register</a></li>
            <li class="nav-item">
              <button type="button" class="nav-link btn btn-link" loginClick>Login</button>
            </li>
          </ul>
        </div>
      </div>
    </nav>
    <login />
    <router-outlet />
  `,
})
/** Application shell: collapsible navbar (hidden by full-screen views), login overlay and router outlet. */
export class AppComponent {
  protected readonly layout = inject(LayoutService);
  protected readonly menuOpen = signal(false);

  protected readonly links: readonly NavLink[] = [
    { path: '/home', label: 'Home' },
    { path: '/dashboard', label: 'Dashboard' },
  ];
}
