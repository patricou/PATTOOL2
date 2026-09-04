import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';

export type AboutTab = 'overview' | 'stack' | 'streaming' | 'resources';

export interface AboutFeatureLink {
  route: string[];
  icon: string;
  labelKey: string;
  descKey: string;
}

export interface AboutExternalLink {
  url: string;
  icon: string;
  labelKey: string;
  descKey: string;
  external?: boolean;
}

@Component({
  selector: 'app-home-maps',
  standalone: true,
  imports: [CommonModule, RouterModule, TranslateModule],
  templateUrl: './about.component.html',
  styleUrls: ['./about.component.css']
})
export class AboutComponent {
  activeTab: AboutTab = 'overview';

  readonly isProduction = environment.production;
  readonly appVersion = '2.0.1';
  readonly copyrightYears = '2017–2026';
  readonly authorName = 'Patrick Deschamps';
  readonly authorSite = 'https://www.patrickdeschamps.com/#/';
  readonly authorCardUrl = 'https://patrickdeschamps.com:8001/';
  readonly githubFront = 'https://github.com/patricou/PATTOOL2/tree/main/PatTool_Front-End';
  readonly githubBack = 'https://github.com/patricou/PATTOOL2/tree/main/PatTool_Back-End';
  readonly mongoAtlasUrl = 'https://www.mongodb.com/cloud/atlas';

  readonly swaggerUrl: string;
  readonly keycloakDevUrl: string;
  readonly keycloakProdUrl = 'https://www.patrickdeschamps.com:8543/auth';

  readonly frontendVersions = {
    angular: '21.0.3',
    typescript: '5.9.2',
    bootstrap: '5.3',
    ngBootstrap: '20.0.0',
    ngxTranslate: '15.0.0',
    agGrid: '34.3.1',
    leaflet: '1.9.4',
    maplibre: '6.1.0',
    three: '0.174.0',
    rxjs: '7.8',
    zone: '0.15.0',
    stomp: '7.2.1',
    sockjs: '1.6.1',
    capacitor: '8.3.4',
    jquery: '3.7'
  };

  readonly backendVersions = {
    java: '21',
    springBoot: '3.3.0',
    springdoc: '2.3.0',
    keycloak: '23.0.7'
  };

  readonly frontendTags = [
    '@ng-bootstrap',
    '@ngx-translate',
    'ag-Grid',
    'Leaflet',
    'MapLibre',
    'Three.js',
    'RxJS',
    'STOMP',
    'SockJS',
    'Capacitor',
    'Chart.js',
    'FullCalendar',
    'Quill'
  ];

  readonly backendTags = [
    'Spring Data MongoDB',
    'Spring WebSocket',
    'Spring Security',
    'Springdoc OpenAPI',
    'Keycloak',
    'Actuator',
    'Mail'
  ];

  readonly featureLinks: AboutFeatureLink[] = [
    { route: ['even'], icon: 'fa-list', labelKey: 'MENU.EVENTSLIST', descKey: 'ABOUT.FEAT_EVENTS' },
    { route: ['photos'], icon: 'fa-picture-o', labelKey: 'MENU.PHOTOS', descKey: 'ABOUT.FEAT_PHOTOS' },
    { route: ['results'], icon: 'fa-comments', labelKey: 'MENU.RESULTS', descKey: 'ABOUT.FEAT_WHATSPAT' },
    { route: ['calendrier'], icon: 'fa-calendar-check-o', labelKey: 'MENU.CALENDAR', descKey: 'ABOUT.FEAT_CALENDAR' },
    { route: ['todolists'], icon: 'fa-tasks', labelKey: 'MENU.TODOLISTS', descKey: 'ABOUT.FEAT_TODO' },
    { route: ['notes'], icon: 'fa-sticky-note', labelKey: 'MENU.NOTES', descKey: 'ABOUT.FEAT_NOTES' },
    { route: ['friends'], icon: 'fa-users', labelKey: 'MENU.FRIENDS', descKey: 'ABOUT.FEAT_FRIENDS' },
    { route: ['links'], icon: 'fa-link', labelKey: 'MENU.LINKS', descKey: 'ABOUT.FEAT_LINKS' },
    { route: ['iot'], icon: 'fa-home', labelKey: 'MENU.IOT_HOME', descKey: 'ABOUT.FEAT_IOT' },
    { route: ['api/meteo-france'], icon: 'fa-cloud', labelKey: 'MENU.METEO_FRANCE', descKey: 'ABOUT.FEAT_GEO' },
    { route: ['tools/world-globe'], icon: 'fa-globe', labelKey: 'MENU.WORLD_GLOBE', descKey: 'ABOUT.FEAT_GLOBE' },
    { route: ['tools/solar-system'], icon: 'fa-sun-o', labelKey: 'MENU.SOLAR_SYSTEM', descKey: 'ABOUT.FEAT_SOLAR' },
    { route: ['tools/ciel'], icon: 'fa-star', labelKey: 'MENU.SKY', descKey: 'ABOUT.FEAT_SKY' },
    { route: ['tools/univers-futur'], icon: 'fa-hourglass-half', labelKey: 'MENU.FUTURE_UNIVERSE', descKey: 'ABOUT.FEAT_FUTURE_UNIVERSE' },
    { route: ['tools/eclipse'], icon: 'fa-moon-o', labelKey: 'MENU.ECLIPSE', descKey: 'ABOUT.FEAT_ECLIPSE' },
    { route: ['tools/astro-compass'], icon: 'fa-video-camera', labelKey: 'MENU.ASTRO_COMPASS', descKey: 'ABOUT.FEAT_ASTRO' },
    { route: ['tools/nord'], icon: 'fa-location-arrow', labelKey: 'MENU.NORD', descKey: 'ABOUT.FEAT_COMPASS' },
    { route: ['tools/direction'], icon: 'fa-crosshairs', labelKey: 'MENU.DIRECTION', descKey: 'ABOUT.FEAT_DIRECTION' },
    { route: ['tools/relief-finder'], icon: 'fa-area-chart', labelKey: 'MENU.RELIEF_FINDER', descKey: 'ABOUT.FEAT_RELIEF' },
    { route: ['api/wiki'], icon: 'fa-graduation-cap', labelKey: 'MENU.WIKI', descKey: 'ABOUT.FEAT_WIKI' },
    { route: ['api/foncier'], icon: 'fa-building', labelKey: 'MENU.FONCIER', descKey: 'ABOUT.FEAT_FONCIER' },
    { route: ['tools/archive-watcher'], icon: 'fa-archive', labelKey: 'MENU.ARCHIVE', descKey: 'ABOUT.FEAT_MEDIA' },
    { route: ['system'], icon: 'fa-cog', labelKey: 'MENU.SYSTEM', descKey: 'ABOUT.FEAT_SYSTEM' }
  ];

  readonly streamingSteps: Array<{ icon: string; titleKey: string; descKey: string }> = [
    { icon: 'fa-info-circle', titleKey: 'ABOUT.STREAMING_ARCHITECTURE', descKey: 'ABOUT.STREAMING_ARCHITECTURE_DESC' },
    { icon: 'fa-server', titleKey: 'ABOUT.STREAMING_BACKEND', descKey: 'ABOUT.STREAMING_BACKEND_DESC' },
    { icon: 'fa-desktop', titleKey: 'ABOUT.STREAMING_FRONTEND', descKey: 'ABOUT.STREAMING_FRONTEND_DESC' },
    { icon: 'fa-check-circle', titleKey: 'ABOUT.STREAMING_BENEFITS', descKey: 'ABOUT.STREAMING_BENEFITS_DESC' },
    { icon: 'fa-lightbulb-o', titleKey: 'ABOUT.STREAMING_APPROACH', descKey: 'ABOUT.STREAMING_APPROACH_DESC' }
  ];

  copyFeedback = '';
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.swaggerUrl = this.buildSwaggerUrl(environment.API_URL);
    this.keycloakDevUrl = this.normalizeKeycloakAdminUrl(environment.keykloakBaseUrl);
  }

  setTab(tab: AboutTab): void {
    this.activeTab = tab;
  }

  get resourceLinks(): AboutExternalLink[] {
    return [
      {
        url: this.swaggerUrl,
        icon: 'fa-book',
        labelKey: 'ABOUT.SWAGGER_DOCS',
        descKey: 'ABOUT.API_DESC',
        external: true
      },
      {
        url: this.keycloakDevUrl,
        icon: 'fa-cog',
        labelKey: 'ABOUT.DEV_ADMIN',
        descKey: 'ABOUT.KEYCLOAK_DESC',
        external: true
      },
      {
        url: this.keycloakProdUrl,
        icon: 'fa-globe',
        labelKey: 'ABOUT.PROD_ADMIN',
        descKey: 'ABOUT.KEYCLOAK_DESC',
        external: true
      },
      {
        url: this.mongoAtlasUrl,
        icon: 'fa-database',
        labelKey: 'ABOUT.MONGODB_ATLAS',
        descKey: 'ABOUT.MONGODB_DESC',
        external: true
      },
      {
        url: this.githubFront,
        icon: 'fa-github',
        labelKey: 'ABOUT.FRONT_END',
        descKey: 'ABOUT.GITHUB_DESC',
        external: true
      },
      {
        url: this.githubBack,
        icon: 'fa-github',
        labelKey: 'ABOUT.BACK_END',
        descKey: 'ABOUT.GITHUB_DESC',
        external: true
      },
      {
        url: this.authorSite,
        icon: 'fa-external-link',
        labelKey: 'ABOUT.AUTHOR_SITE',
        descKey: 'ABOUT.DESIGNED_BY',
        external: true
      }
    ];
  }

  async copyText(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.showCopyFeedback('ABOUT.COPY_OK');
    } catch {
      this.showCopyFeedback('ABOUT.COPY_FAIL');
    }
  }

  private showCopyFeedback(key: string): void {
    this.copyFeedback = key;
    if (this.copyTimer) {
      clearTimeout(this.copyTimer);
    }
    this.copyTimer = setTimeout(() => {
      this.copyFeedback = '';
      this.copyTimer = null;
    }, 2000);
  }

  private buildSwaggerUrl(apiUrl: string): string {
    const trimmed = (apiUrl || '').replace(/\/api\/?$/i, '').replace(/\/$/, '');
    if (!trimmed || trimmed.startsWith('/')) {
      return '/swagger-ui.html';
    }
    return `${trimmed}/swagger-ui.html`;
  }

  private normalizeKeycloakAdminUrl(base: string): string {
    const raw = (base || '').replace(/\/$/, '');
    if (!raw) {
      return 'http://localhost:8080';
    }
    // Admin console is typically at /auth or host root; strip trailing /auth for console home
    return raw.replace(/\/auth$/i, '') || raw;
  }
}
