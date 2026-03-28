import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { HttpClientModule } from '@angular/common/http';
import { LinksComponent } from './links/links.component';
import { TranslateModule } from '@ngx-translate/core';
import { UrllinkService } from '../services/urllink.service';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';

/**
 * Use root TranslateModule only — do not register TranslateHttpLoader here.
 * A child loader refetches entire i18n JSON on each lazy load and slows the links page.
 */
@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    RouterModule.forChild([
      { path: '', component: LinksComponent }
    ]),
    HttpClientModule,
    TranslateModule,
    NavigationButtonsModule,
    LinksComponent
  ],
  declarations: [],
  exports: [LinksComponent],
  providers:[UrllinkService]
})
export class LinksModule { }
