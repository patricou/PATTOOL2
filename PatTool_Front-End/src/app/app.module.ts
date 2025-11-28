import { BrowserModule } from '@angular/platform-browser';
import { NgModule, Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClientModule, HttpClient } from '@angular/common/http';
import { RouterModule } from '@angular/router';
import { TranslateModule, TranslateLoader } from '@ngx-translate/core';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { provideFirebaseApp, initializeApp } from '@angular/fire/app';
import { getDatabase, provideDatabase } from '@angular/fire/database';
import { getAuth, provideAuth } from '@angular/fire/auth';
import { HomeModule } from "./home/home.module";
import { EvenementsModule } from './evenements/evenements.module';
import { ChatModule } from './communications/communications.module';
import { MapsModule } from './other/other.module';
import { AppComponent } from './app.component';
import { HomePageComponent } from './home/home-page/home-page.component';
import { HomeEvenementsComponent } from './evenements/home-evenements/home-evenements.component';
import { PageNotFoundComponent } from './page-not-found/page-not-found.component';
import { ChatComponent } from './communications/chat/chat.component';
import { AboutComponent } from './other/about/about.component';
import { CreateEvenementComponent } from './evenements/create-evenement/create-evenement.component';
import { UpdateEvenementComponent } from './evenements/update-evenement/update-evenement.component';
import { DetailsEvenementComponent } from './evenements/details-evenement/details-evenement.component';
import { KeycloakService } from './keycloak/keycloak.service';
import { KeycloakHttpInterceptor } from './keycloak/keycloak.http';
import { HTTP_INTERCEPTORS } from '@angular/common/http';
import { MembersService } from './services/members.service';
import { CommonvaluesService } from './services/commonvalues.service';
import { FileService } from './services/file.service';
import { environment } from '../environments/environment';
import { LinksComponent } from './links/links/links.component';
import { LinksModule } from './links/links.module';
import { HashLocationStrategy, LocationStrategy } from '@angular/common';
import { PatgptComponent } from './patgpt/patgpt/patgpt.component';
import { PatgptModule } from './patgpt/patgpt.module';
import { IothomeComponent } from './iothome/iothome.component';
import { IotService } from './services/iot.service';
import { NavigationButtonsModule } from './shared/navigation-buttons/navigation-buttons.module';
import { SlideshowModalModule } from './shared/slideshow-modal/slideshow-modal.module';
import { LinksAdminModule } from './admin/links-admin/links-admin.module';
import { LinksAdminComponent } from './admin/links-admin/links-admin.component';
import { UnsavedChangesGuard } from './guards/unsaved-changes.guard';
import { SystemComponent } from './system/system.component';
import { CacheService } from './services/cache.service';

// AoT requires an exported function for factories
export function HttpLoaderFactory(http: HttpClient) {
	return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

@NgModule({
	declarations: [
		AppComponent,
		PageNotFoundComponent,
		IothomeComponent,
		DetailsEvenementComponent,
		SystemComponent,
	],
	imports: [
		BrowserModule,
		FormsModule,
		HttpClientModule,
		HomeModule,
		EvenementsModule,
		ChatModule,
		MapsModule,
		LinksModule,
		LinksAdminModule,
		PatgptModule,
		NavigationButtonsModule,
		SlideshowModalModule,
		TranslateModule.forRoot({
			loader: {
				provide: TranslateLoader,
				useFactory: HttpLoaderFactory,
				deps: [HttpClient]
			}
		}),
		RouterModule.forRoot([
			{ path: '', redirectTo: 'even', pathMatch: 'full' },
			{ path: 'even', component: HomeEvenementsComponent },
			{ path: 'neweven', component: CreateEvenementComponent },
			{ path: 'updeven/:id', component: UpdateEvenementComponent, canDeactivate: [UnsavedChangesGuard] },
			{ path: 'details-evenement/:id', component: DetailsEvenementComponent },
			{ path: 'results', component: ChatComponent },
			{ path: 'maps', component: AboutComponent },
					{ path: 'links', component: LinksComponent },
		{ path: 'links-admin', component: LinksAdminComponent },
		{ path: 'iot', component: IothomeComponent },
		{ path: 'patgpt', component: PatgptComponent },
		{ path: 'system', component: SystemComponent },
			{ path: 'home', component: HomePageComponent },
			{ path: '**', component: PageNotFoundComponent }
		]),
		NgbModule,
	],
	providers: [
		KeycloakService,
		MembersService,
		FileService,
		CommonvaluesService,
		IotService,
		CacheService,
		// to be able to do F5 in prod		
		{ provide: LocationStrategy, useClass: HashLocationStrategy },
		{ provide: TranslateLoader, useFactory: HttpLoaderFactory, deps: [HttpClient] },
		// HTTP Interceptor
		{ provide: HTTP_INTERCEPTORS, useClass: KeycloakHttpInterceptor, multi: true },
		// Firebase providers
		provideFirebaseApp(() => initializeApp(environment.firebase)),
		provideDatabase(() => getDatabase()),
		provideAuth(() => getAuth())
	],
	bootstrap: [AppComponent]
})
export class AppModule { }
