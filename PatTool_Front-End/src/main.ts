import { enableProdMode } from '@angular/core';
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { AppModule } from './app/app.module';
import { environment } from './environments/environment';
import { KeycloakService } from './app/keycloak/keycloak.service';

if (environment.production) {
  enableProdMode();
}

// Suppress Google Maps diagnostic requests blocked by ad blockers
// These are harmless telemetry requests that don't affect functionality
window.addEventListener('error', (event) => {
  if (event.message && typeof event.message === 'string') {
    // Ignore Google Maps gen_204 requests blocked by ad blockers
    if (event.message.includes('gen_204') || 
        event.message.includes('maps.googleapis.com') ||
        event.message.includes('ERR_BLOCKED_BY_CLIENT')) {
      event.preventDefault();
      return false;
    }
  }
  return true;
}, true);

// Also handle unhandled promise rejections for network errors
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason && typeof event.reason === 'string') {
    if (event.reason.includes('gen_204') || 
        event.reason.includes('maps.googleapis.com') ||
        event.reason.includes('ERR_BLOCKED_BY_CLIENT')) {
      event.preventDefault();
      return false;
    }
  }
  return true;
});

// platformBrowserDynamic().bootstrapModule(AppModule);

KeycloakService.init()
  .then(() => {
    const platform = platformBrowserDynamic();
    platform.bootstrapModule(AppModule);
  })
  .catch(() => window.location.reload());