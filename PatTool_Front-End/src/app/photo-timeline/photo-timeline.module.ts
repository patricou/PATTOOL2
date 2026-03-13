import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { HttpClientModule, HttpClient } from '@angular/common/http';
import { PhotoTimelineComponent } from './photo-timeline/photo-timeline.component';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
import { TranslateLoader, TranslateModule } from '@ngx-translate/core';
import { PhotoTimelineService } from '../services/photo-timeline.service';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { SlideshowModalModule } from '../shared/slideshow-modal/slideshow-modal.module';

export function HttpLoaderFactory(http: HttpClient) {
    return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        RouterModule.forChild([
            { path: '', component: PhotoTimelineComponent }
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
        SlideshowModalModule,
        PhotoTimelineComponent
    ],
    declarations: [],
    exports: [PhotoTimelineComponent],
    providers: [PhotoTimelineService]
})
export class PhotoTimelineModule { }
