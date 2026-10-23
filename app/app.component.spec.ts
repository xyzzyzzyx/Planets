import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AppComponent } from './app.component';
import { routes } from './app.routes';
import { LayoutService } from './layout.service';
import { LoginService } from './login.service';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AppComponent], providers: [provideRouter(routes.filter((r) => !r.loadComponent))] }).compileComponents();
  });

  it('renders the navbar with every section', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    await fixture.whenStable();
    const links = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.navbar-nav a')].map((a) => a.textContent?.trim());
    expect(links).toEqual(['Home', 'Dashboard', 'Register']);
  });

  it('hides the navbar when the layout asks for it', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    TestBed.inject(LayoutService).setNavbarHidden(true);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('nav')!.classList).toContain('navbar-hidden');
  });

  it('the toggler expands the collapsed menu on small screens', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.navbar-toggler')!.click();
    await fixture.whenStable();
    expect(el.querySelector('#navNav')!.classList).toContain('show');
    expect(el.querySelector('.navbar-toggler')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('the Login button opens the login overlay', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    await fixture.whenStable();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[loginClick]')!.click();
    await fixture.whenStable();
    expect(TestBed.inject(LoginService).showing()).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('.login-overlay')).not.toBeNull();
  });

  it('redirects the root and unknown URLs to /home', async () => {
    TestBed.createComponent(AppComponent);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    expect(router.url).toBe('/home');
    await router.navigateByUrl('/does/not/exist');
    expect(router.url).toBe('/home');
  });
});

describe('routes', () => {
  it('lazy-loads every heavy view', async () => {
    const lazy = routes.filter((r) => r.loadComponent);
    expect(lazy.map((r) => r.path)).toEqual(['register', 'settings', 'setup', 'dashboard']);
    for (const route of lazy) expect(await route.loadComponent!()).toBeTruthy();
  });
});
