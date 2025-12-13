import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule, HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateLoader } from '@ngx-translate/core';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
import { ChatComponent } from './chat/chat.component';
import { DiscussionComponent } from './discussion/discussion.component';
import { DiscussionModalComponent } from './discussion-modal/discussion-modal.component';
import { DiscussionStatisticsModalComponent } from './discussion-statistics-modal/discussion-statistics-modal.component';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { DiscussionService } from '../services/discussion.service';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';

// AoT requires an exported function for factories
export function HttpLoaderFactory(http: HttpClient) {
  return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    HttpClientModule,
    TranslateModule.forChild({
      loader: {
        provide: TranslateLoader,
        useFactory: HttpLoaderFactory,
        deps: [HttpClient]
      }
    }),
    NavigationButtonsModule,
    NgbModule
  ],
  declarations: [ChatComponent, DiscussionComponent, DiscussionModalComponent, DiscussionStatisticsModalComponent],
  exports: [ChatComponent, DiscussionComponent, DiscussionModalComponent, DiscussionStatisticsModalComponent],
  providers: [
    DiscussionService
  ]
})
export class ChatModule { }
