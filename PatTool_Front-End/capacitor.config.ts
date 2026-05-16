import type { CapacitorConfig } from '@capacitor/cli';

/** Run `npm run cap:sync` after `ng build` so native projects pick up bundled web assets. */
const config: CapacitorConfig = {
  appId: 'com.pattool.frontend',
  appName: 'PatTool',
  /** Aligns with Angular build output so Back-End serves the same artefacts in dev/prod bundles. */
  webDir: '../PatTool_Back-End/src/main/resources/static',
};

export default config;
