import { TestBed } from '@angular/core/testing';
import { HomeComponent } from './home.component';
import { RegisterComponent } from './register.component';
import { SettingsComponent } from './settings.component';
import { SetupComponent } from './setup.component';

describe('placeholder pages', () => {
  it.each([
    [HomeComponent, 'Home'],
    [RegisterComponent, 'Register'],
    [SettingsComponent, 'Settings'],
    [SetupComponent, 'Setup'],
  ] as const)('%o renders its heading', async (component, heading) => {
    const fixture = TestBed.createComponent(component);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('h1')?.textContent).toBe(heading);
  });
});
