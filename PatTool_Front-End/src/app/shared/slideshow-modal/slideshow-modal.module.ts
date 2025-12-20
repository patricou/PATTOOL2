import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { SlideshowModalComponent } from './slideshow-modal.component';
import { FileService } from '../../services/file.service';

@NgModule({
  declarations: [
  ],
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    NgbModule,
    SlideshowModalComponent
  ],
  exports: [
    SlideshowModalComponent
  ],
  providers: [
    FileService
  ]
})
export class SlideshowModalModule { }

