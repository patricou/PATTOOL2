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
import { AccesRefuseEvenementComponent } from './evenements/acces-refuse-evenement/acces-refuse-evenement.component';
import { KeycloakHttpInterceptor } from './keycloak/keycloak.http';
import { HTTP_INTERCEPTORS } from '@angular/common/http';
import { MembersService } from './services/members.service';
import { CommonvaluesService } from './services/commonvalues.service';
import { FileService } from './services/file.service';
import { environment } from '../environments/environment';
import { LinksAdminModule } from './admin/links-admin/links-admin.module';
import { LinksAdminComponent } from './admin/links-admin/links-admin.component';
import { HashLocationStrategy, LocationStrategy, IMAGE_CONFIG } from '@angular/common';
import { UnsavedChangesGuard } from './guards/unsaved-changes.guard';
import { IotService } from './services/iot.service';
import { LocalNetworkService } from './services/local-network.service';
import { NavigationButtonsModule } from './shared/navigation-buttons/navigation-buttons.module';
import { SlideshowModalModule } from './shared/slideshow-modal/slideshow-modal.module';
import { TraceViewerModalModule } from './shared/trace-viewer-modal/trace-viewer-modal.module';
import { CacheService } from './services/cache.service';
import { FriendsService } from './services/friends.service';
import { ApiService } from './services/api.service';
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
		AccesRefuseEvenementComponent,
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
			{ path: '', redirectTo: 'photos', pathMatch: 'full' },
			{ path: 'even', component: HomeEvenementsComponent },
			{ path: 'neweven', component: CreateEvenementComponent },
			{ path: 'updeven/:id', component: UpdateEvenementComponent, canDeactivate: [UnsavedChangesGuard] },
			{ path: 'details-evenement/:id', component: DetailsEvenementComponent },
			{ path: 'acces-refuse-evenement/:id', component: AccesRefuseEvenementComponent },
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
				path: 'iot', 
				loadComponent: () => import('./iothome/iothome.component').then(m => m.IothomeComponent)
			},
			{ 
				path: 'iot/local-network', 
				loadComponent: () => import('./local-network/local-network.component').then(m => m.LocalNetworkComponent)
			},
			{
				path: 'iot/cameras',
				loadComponent: () => import('./iot-cameras/iot-cameras.component').then(m => m.IotCamerasComponent)
			},
			{
				path: 'iot/proxy',
				loadComponent: () => import('./iot-proxy/iot-proxy.component').then(m => m.IotProxyComponent)
			},
			{ 
				path: 'photos', 
				loadChildren: () => import('./photo-timeline/photo-timeline.module').then(m => m.PhotoTimelineModule)
			},
			{ 
				path: 'system', 
				loadComponent: () => import('./system/system.component').then(m => m.SystemComponent)
			},
			{ 
				path: 'api/openweathermap', 
				loadComponent: () => import('./openweathermap/openweathermap.component').then(m => m.OpenWeatherMapComponent)
			},
			{ 
				path: 'api/address-geocode', 
				loadComponent: () => import('./address-geocode/address-geocode.component').then(m => m.AddressGeocodeComponent)
			},
			{
				path: 'api/news',
				loadComponent: () => import('./news/news.component').then(m => m.NewsComponent)
			},
			{
				path: 'api/currency-converter',
				loadComponent: () => import('./currency-converter/currency-converter.component').then(m => m.CurrencyConverterComponent)
			},
			{
				path: 'api/stock-exchange',
				loadComponent: () => import('./stock-exchange/stock-exchange.component').then(m => m.StockExchangeComponent)
			},
			{
				path: 'tools/loto',
				loadComponent: () => import('./loto/loto.component').then(m => m.LotoComponent)
			},
			{
				path: 'tools/euromillions',
				loadComponent: () => import('./euromillions/euromillions.component').then(m => m.EuromillionsComponent)
			},
			{
				path: 'tools/calculator',
				loadComponent: () => import('./calculator/calculator.component').then(m => m.CalculatorComponent)
			},
			{
				path: 'calendrier',
				loadComponent: () => import('./calendar/calendar.component').then(m => m.CalendarComponent)
			},
			{
				path: 'todolists',
				loadComponent: () => import('./todolists/todolists.component').then(m => m.TodolistsComponent)
			},
			{ path: '**', redirectTo: 'home', pathMatch: 'full' }
		], { onSameUrlNavigation: 'reload' }),
		NgbModule,
	],
	providers: [
		MembersService,
		FileService,
		CommonvaluesService,
		IotService,
		LocalNetworkService,
		CacheService,
		FriendsService, // Provided globally because used by HomeEvenementsComponent (eager-loaded)
		ApiService,
		// to be able to do F5 in prod		
		{ provide: LocationStrategy, useClass: HashLocationStrategy },
		{ provide: TranslateLoader, useFactory: HttpLoaderFactory, deps: [HttpClient] },
		// HTTP Interceptor
		{ provide: HTTP_INTERCEPTORS, useClass: KeycloakHttpInterceptor, multi: true },
		/**
		 * Désactive les warnings dev d'Angular sur les <img> :
		 *   - disableImageSizeWarning : NG0913 (« An image with src ... has intrinsic
		 *     dimensions much larger than its rendered size »). On l'a en permanence
		 *     pour les images générées par DALL·E 3 (1024×1024 ou 1024×1536, avec
		 *     les metadata C2PA en plus) qui sont volontairement affichées plus
		 *     petites dans le chat assistant. La pleine résolution est conservée
		 *     pour la copie presse-papier, le slideshow, le partage WhatsApp et
		 *     l'insertion en pièce jointe d'événement.
		 *   - disableImageLazyLoadWarning : NG0914 (loading="lazy" sur image LCP).
		 *
		 * Ces warnings n'apparaissent qu'en dev et n'affectent pas le runtime prod,
		 * mais ils polluent la console en boucle dès qu'on génère une image.
		 */
		{ provide: IMAGE_CONFIG, useValue: { disableImageSizeWarning: true, disableImageLazyLoadWarning: true } }
	]
})
export class AppModule implements DoBootstrap {
	ngDoBootstrap(appRef: ApplicationRef): void {
		// Bootstrap the standalone AppComponent
		appRef.bootstrap(AppComponent);
	}
}
