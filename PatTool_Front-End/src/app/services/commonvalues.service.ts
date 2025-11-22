import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Member } from '../model/member';

@Injectable()
export class CommonvaluesService {

    private dataFilter: string = "";
    private lang: string;

    constructor(private _translate: TranslateService) {
        // set the langage by the browser langage                
        let browserLang = this._translate.getBrowserLang();
        // Check if browser language is in our supported languages
        const supportedLangs = ['ar', 'cn', 'de', 'el', 'en', 'es', 'fr', 'he', 'it', 'jp', 'ru'];
        this.lang = browserLang && supportedLangs.includes(browserLang) ? browserLang : 'en';
        //console.info("Value of lang in Constructor service commonValue : " + JSON.stringify(this.lang));
    };

    setDataFilter(dataFilter: string) {
        this.dataFilter = dataFilter;
    }

    getDataFilter(): string {
        return this.dataFilter;
    }

    setLang(lang: string) {
        this.lang = lang;
    };

    getLang(): string {
        return this.lang;
    };


}
