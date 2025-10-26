import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { LinksAdminComponent } from './links-admin.component';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';

@NgModule({
  declarations: [
    LinksAdminComponent
  ],
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    NavigationButtonsModule
  ],
  exports: [
    LinksAdminComponent
  ]
})
export class LinksAdminModule { }
