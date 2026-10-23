import { Routes } from '@angular/router';
import { HomeComponent } from './home.component';

/** App routes. Everything except the home page is lazy-loaded (three.js lives only in the dashboard chunk). */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  { path: 'home', component: HomeComponent, title: 'Planets' },
  { path: 'register', loadComponent: () => import('./register.component').then((m) => m.RegisterComponent), title: 'Register · Planets' },
  { path: 'settings', loadComponent: () => import('./settings.component').then((m) => m.SettingsComponent), title: 'Settings · Planets' },
  { path: 'setup', loadComponent: () => import('./setup.component').then((m) => m.SetupComponent), title: 'Setup · Planets' },
  { path: 'dashboard', loadComponent: () => import('./dashboard.component').then((m) => m.DashboardComponent), title: 'Dashboard · Planets' },
  { path: '**', redirectTo: 'home' },
];
