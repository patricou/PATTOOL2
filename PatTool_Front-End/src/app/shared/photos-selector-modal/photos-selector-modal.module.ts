import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { PhotosSelectorModalComponent } from './photos-selector-modal.component';

@NgModule({
  declarations: [
    PhotosSelectorModalComponent
  ],
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    NgbModule
  ],
  exports: [
    PhotosSelectorModalComponent
  ]
})
export class PhotosSelectorModalModule { }

