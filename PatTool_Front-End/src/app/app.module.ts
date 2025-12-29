import { BrowserModule } from '@angular/platform-browser';
import { NgModule, Component, DoBootstrap, ApplicationRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClientModule, HttpClient } from '@angular/common/http';
import { RouterModule } from '@angular/router';
import { TranslateModule, TranslateLoader } from '@ngx-translate/core';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
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
import { LinksAdminModule } from './admin/links-admin/links-admin.module';
import { LinksAdminComponent } from './admin/links-admin/links-admin.component';
import { HashLocationStrategy, LocationStrategy } from '@angular/common';
import { UnsavedChangesGuard } from './guards/unsaved-changes.guard';
import { IotService } from './services/iot.service';
import { NavigationButtonsModule } from './shared/navigation-buttons/navigation-buttons.module';
import { SlideshowModalModule } from './shared/slideshow-modal/slideshow-modal.module';
import { TraceViewerModalModule } from './shared/trace-viewer-modal/trace-viewer-modal.module';
import { CacheService } from './services/cache.service';
import { FriendsService } from './services/friends.service';
import { AgGridModule } from 'ag-grid-angular';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';

// Register AG Grid modules
ModuleRegistry.registerModules([AllCommunityModule]);

// AoT requires an exported function for factories
export function HttpLoaderFactory(http: HttpClient) {
	return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

@NgModule({
	declarations: [
	],
	imports: [
		BrowserModule,
		FormsModule,
		HttpClientModule,
		AppComponent,
		PageNotFoundComponent,
		DetailsEvenementComponent,
		HomeModule,
		EvenementsModule,
		ChatModule,
		MapsModule,
		LinksAdminModule,
		NavigationButtonsModule,
		SlideshowModalModule,
		TraceViewerModalModule,
		AgGridModule,
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
			{ path: 'links-admin', component: LinksAdminComponent },
			{ path: 'home', component: HomePageComponent },
			// Lazy loaded routes - loaded on demand to reduce initial bundle size
			{ 
				path: 'links', 
				loadChildren: () => import('./links/links.module').then(m => m.LinksModule)
			},
			{ 
				path: 'friends', 
				loadChildren: () => import('./friends/friends.module').then(m => m.FriendsModule)
			},
			{ 
				path: 'patgpt', 
				loadChildren: () => import('./patgpt/patgpt.module').then(m => m.PatgptModule)
			},
			{ 
				path: 'iot', 
				loadComponent: () => import('./iothome/iothome.component').then(m => m.IothomeComponent)
			},
			{ 
				path: 'system', 
				loadComponent: () => import('./system/system.component').then(m => m.SystemComponent)
			},
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
		FriendsService, // Provided globally because used by HomeEvenementsComponent (eager-loaded)
		// to be able to do F5 in prod		
		{ provide: LocationStrategy, useClass: HashLocationStrategy },
		{ provide: TranslateLoader, useFactory: HttpLoaderFactory, deps: [HttpClient] },
		// HTTP Interceptor
		{ provide: HTTP_INTERCEPTORS, useClass: KeycloakHttpInterceptor, multi: true }
	]
})
export class AppModule implements DoBootstrap {
	ngDoBootstrap(appRef: ApplicationRef): void {
		// Bootstrap the standalone AppComponent
		appRef.bootstrap(AppComponent);
	}
}
