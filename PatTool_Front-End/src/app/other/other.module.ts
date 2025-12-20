import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClientModule, HttpClient } from '@angular/common/http';
import { AboutComponent } from './about/about.component';
import { TranslateModule, TranslateLoader } from '@ngx-translate/core';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { ExceptionReportService } from '../services/exception-report.service';
import { KeycloakService } from '../keycloak/keycloak.service';

// AoT requires an exported function for factories
export function HttpLoaderFactory(http: HttpClient) {
  return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

@NgModule({
  imports: [
    CommonModule,
    HttpClientModule,
    TranslateModule.forChild({
      loader: {
        provide: TranslateLoader,
        useFactory: HttpLoaderFactory,
        deps: [HttpClient]
      }
    }),
    NgbModule,
    NavigationButtonsModule,
    AboutComponent
  ],
  declarations: [],
  exports: [AboutComponent],
  providers: [
    ExceptionReportService,
    KeycloakService
  ]
})
export class MapsModule { }
