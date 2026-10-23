import { TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { LoginComponent } from './login.component';
import { LoginDirective } from './login.directive';
import { LoginService } from './login.service';
import { LayoutService } from './layout.service';

@Component({ imports: [LoginDirective, LoginComponent], template: `<button loginClick>Login</button><login />` })
class HostComponent { }

describe('LoginService', () => {
  it('toggles and sets visibility', () => {
    const service = TestBed.inject(LoginService);
    expect(service.showing()).toBe(false);
    service.toggle();
    expect(service.showing()).toBe(true);
    service.setShowing(false);
    expect(service.showing()).toBe(false);
  });
});

describe('LayoutService', () => {
  it('toggles the navbar', () => {
    const layout = TestBed.inject(LayoutService);
    layout.toggleNavbar();
    expect(layout.navbarHidden()).toBe(true);
    layout.setNavbarHidden(false);
    expect(layout.navbarHidden()).toBe(false);
  });
});

describe('Login directive + component', () => {
  let el: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<HostComponent>>;
  const button = () => el.querySelector<HTMLButtonElement>('button[loginClick]')!;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    el = fixture.nativeElement;
    await fixture.whenStable();
  });

  it('the directive toggles the overlay and reflects state via aria-pressed', async () => {
    button().click();
    await fixture.whenStable();
    expect(el.querySelector('.login-overlay')).not.toBeNull();
    expect(button().getAttribute('aria-pressed')).toBe('true');
    button().click();
    await fixture.whenStable();
    expect(el.querySelector('.login-overlay')).toBeNull();
  });

  it('requires a valid email and password before submitting', async () => {
    TestBed.inject(LoginService).setShowing(true);
    await fixture.whenStable();
    const submit = el.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(submit.disabled).toBe(true);
    const email = el.querySelector<HTMLInputElement>('#login-email')!;
    const password = el.querySelector<HTMLInputElement>('#login-password')!;
    email.value = 'ada@example.com';
    email.dispatchEvent(new Event('input'));
    password.value = 'secret';
    password.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(submit.disabled).toBe(false);
    submit.click();
    await fixture.whenStable();
    expect(TestBed.inject(LoginService).showing()).toBe(false);
  });

  it('submit clears the password; cancel and Escape clear everything and close', async () => {
    const login = fixture.debugElement.children[1].componentInstance as LoginComponent;
    const service = TestBed.inject(LoginService);
    service.setShowing(true);
    login.credentials = { email: 'a@b.c', password: 'pw' };
    login.onSubmit();
    expect(login.credentials).toEqual({ email: 'a@b.c', password: '' });
    service.setShowing(true);
    login.onCancel();
    expect(login.credentials).toEqual({ email: '', password: '' });
    service.setShowing(true);
    await fixture.whenStable();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(service.showing()).toBe(false);
  });

  it('renders accessible social sign-in links', async () => {
    TestBed.inject(LoginService).setShowing(true);
    await fixture.whenStable();
    const links = [...el.querySelectorAll('.social-links a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/auth/google', '/auth/linkedin', '/auth/github', '/auth/microsoft', '/auth/twitter']);
    expect(links.every((a) => a.getAttribute('aria-label')?.startsWith('Sign in with'))).toBe(true);
  });
});
