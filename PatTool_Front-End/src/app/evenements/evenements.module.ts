import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClientModule, HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { TranslateModule, TranslateLoader } from '@ngx-translate/core';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
// Removed incompatible third-party libraries
// import { NgxMyDatePickerModule } from 'ngx-mydatepicker';
// import { FileUploadModule } from 'ng2-file-upload';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { provideFirebaseApp, initializeApp } from '@angular/fire/app';
import { getFirestore, provideFirestore } from '@angular/fire/firestore';
import { getAuth, provideAuth } from '@angular/fire/auth';
import { environment } from '../../environments/environment';

import { HomeEvenementsComponent } from './home-evenements/home-evenements.component';
import { EvenementsService } from '../services/evenements.service';
import { CreateEvenementComponent } from './create-evenement/create-evenement.component';
import { ElementEvenementComponent } from './element-evenement/element-evenement.component';
import { UpdateEvenementComponent } from './update-evenement/update-evenement.component';
import { WindowRefService } from '../services/window-ref.service';
import { CommonvaluesService } from '../services/commonvalues.service';

// AoT requires an exported function for factories
export function HttpLoaderFactory(http: HttpClient) {
	return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

@NgModule({
	imports: [
		CommonModule,
		FormsModule,
		HttpClientModule,
		RouterModule,
		TranslateModule.forChild({
			loader: {
				provide: TranslateLoader,
				useFactory: HttpLoaderFactory,
				deps: [HttpClient]
			}
		}),
		// NgxMyDatePickerModule, // Removed - incompatible with Angular Ivy
		// FileUploadModule, // Removed - incompatible with Angular Ivy
		NgbModule
	],
	declarations: [
		HomeEvenementsComponent, CreateEvenementComponent, ElementEvenementComponent, UpdateEvenementComponent
	],
	exports: [HomeEvenementsComponent, CreateEvenementComponent, ElementEvenementComponent, UpdateEvenementComponent
	],
	providers: [
		EvenementsService,
		WindowRefService,
		CommonvaluesService,
		// Firebase providers for this module
		provideFirebaseApp(() => initializeApp(environment.firebase)),
		provideFirestore(() => getFirestore()),
		provideAuth(() => getAuth())
	]
})
export class EvenementsModule { }
