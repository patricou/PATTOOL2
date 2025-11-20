import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { VideoshowModalComponent } from './videoshow-modal.component';
import { FileService } from '../../services/file.service';

@NgModule({
  declarations: [
    VideoshowModalComponent
  ],
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    NgbModule
  ],
  exports: [
    VideoshowModalComponent
  ],
  providers: [
    FileService
  ]
})
export class VideoshowModalModule { }

