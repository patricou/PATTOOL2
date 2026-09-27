import type { CapacitorConfig } from '@capacitor/cli';

/** Run `npm run cap:sync` after `ng build` so native projects pick up bundled web assets. */
const config: CapacitorConfig = {
  appId: 'com.pattool.frontend',
  appName: 'PatTool',
  /** Phone bundle. The Spring static folder stays the website build (relative /api/). */
  webDir: 'www',
  server: {
    androidScheme: 'https',
    /** Keycloak login (online only) must stay inside the WebView. */
    allowNavigation: ['www.patrickdeschamps.com', 'patrickdeschamps.com']
  }
};

export default config;
