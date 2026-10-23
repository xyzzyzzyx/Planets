import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<h1>Settings</h1>`,
})
/** Placeholder page. */
export class SettingsComponent { }
