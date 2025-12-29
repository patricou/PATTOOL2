import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { HttpClientModule, HttpClient } from '@angular/common/http';
import { FriendsComponent } from './friends/friends.component';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
import { TranslateLoader, TranslateModule } from '@ngx-translate/core';
import { FriendsService } from '../services/friends.service';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { ChatModule } from '../communications/communications.module';

// AoT requires an exported function for factories
export function HttpLoaderFactory(http: HttpClient) {
  return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    RouterModule.forChild([
      { path: '', component: FriendsComponent }
    ]),
    HttpClientModule,
    TranslateModule.forChild({
      loader: {
        provide: TranslateLoader,
        useFactory: HttpLoaderFactory,
        deps: [HttpClient]
      }
    }),
    NavigationButtonsModule,
    NgbModule,
    ChatModule,
    FriendsComponent
  ],
  declarations: [],
  exports: [FriendsComponent],
  providers: [FriendsService]
})
export class FriendsModule { }

