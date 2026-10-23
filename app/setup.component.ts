import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-setup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<h1>Setup</h1>`,
})
/** Placeholder page. */
export class SetupComponent { }
