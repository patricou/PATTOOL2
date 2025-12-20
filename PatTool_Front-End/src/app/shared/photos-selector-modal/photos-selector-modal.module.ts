import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { PhotosSelectorModalComponent } from './photos-selector-modal.component';

@NgModule({
  declarations: [
  ],
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    TranslateModule,
    NgbModule,
    PhotosSelectorModalComponent
  ],
  exports: [
    PhotosSelectorModalComponent
  ]
})
export class PhotosSelectorModalModule { }

