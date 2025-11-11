import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { FormsModule } from '@angular/forms';
import { TraceViewerModalComponent } from './trace-viewer-modal.component';

@NgModule({
	declarations: [TraceViewerModalComponent],
	imports: [
		CommonModule,
		TranslateModule,
		NgbModule,
		FormsModule
	],
	exports: [TraceViewerModalComponent]
})
export class TraceViewerModalModule { }

