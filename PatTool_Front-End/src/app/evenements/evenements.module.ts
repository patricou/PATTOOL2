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

import { HomeEvenementsComponent } from './home-evenements/home-evenements.component';
import { EvenementsService } from '../services/evenements.service';
import { CreateEvenementComponent } from './create-evenement/create-evenement.component';
import { ElementEvenementComponent } from './element-evenement/element-evenement.component';
// UpdateEvenementComponent is standalone, not imported here
import { WindowRefService } from '../services/window-ref.service';
import { CommonvaluesService } from '../services/commonvalues.service';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { SlideshowModalModule } from '../shared/slideshow-modal/slideshow-modal.module';
import { VideoshowModalModule } from '../shared/videoshow-modal/videoshow-modal.module';
import { PhotosSelectorModalModule } from '../shared/photos-selector-modal/photos-selector-modal.module';
import { TraceViewerModalModule } from '../shared/trace-viewer-modal/trace-viewer-modal.module';
import { ChatModule } from '../communications/communications.module';

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
		NgbModule,
		NavigationButtonsModule,
		SlideshowModalModule,
		VideoshowModalModule,
		PhotosSelectorModalModule,
		TraceViewerModalModule,
		ChatModule,
		HomeEvenementsComponent,
		CreateEvenementComponent,
		ElementEvenementComponent
		// UpdateEvenementComponent is standalone, not exported here
	],
	declarations: [
	],
	exports: [
		HomeEvenementsComponent,
		CreateEvenementComponent,
		ElementEvenementComponent
		// UpdateEvenementComponent is standalone, not exported here
	],
	providers: [
		EvenementsService,
		WindowRefService,
		CommonvaluesService
	]
})
export class EvenementsModule { }
