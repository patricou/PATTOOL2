import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

import {
  ApiService,
  WikipediaSearchPage,
  WikipediaSummary
} from '../services/api.service';

interface WikiLangOption {
  code: string;
  label: string;
}

@Component({
  selector: 'app-wiki',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './wiki.component.html',
  styleUrls: ['./wiki.component.css']
})
export class WikiComponent implements OnInit, OnDestroy {

  readonly langs: WikiLangOption[] = [
    { code: 'fr', label: 'Français' },
    { code: 'en', label: 'English' },
    { code: 'de', label: 'Deutsch' },
    { code: 'es', label: 'Español' },
    { code: 'it', label: 'Italiano' },
    { code: 'ru', label: 'Русский' },
    { code: 'ja', label: '日本語' },
    { code: 'zh', label: '中文' },
    { code: 'ar', label: 'العربية' },
    { code: 'he', label: 'עברית' },
    { code: 'el', label: 'Ελληνικά' },
    { code: 'hi', label: 'हिन्दी' }
  ];

  query = '';
  lang = 'fr';
  results: WikipediaSearchPage[] = [];
  selectedKey: string | null = null;
  article: WikipediaSummary | null = null;

  searching = false;
  loadingArticle = false;
  searched = false;
  errorMessage = '';

  private readonly query$ = new Subject<string>();
  private searchSub?: Subscription;
  private articleSub?: Subscription;
  private readonly subs: Subscription[] = [];

  constructor(
    private api: ApiService,
    private translate: TranslateService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    this.lang = this.normalizeLang(params.get('lang') || this.translate.currentLang || 'fr');
    this.query = (params.get('q') || '').trim();
    const title = params.get('title');

    this.subs.push(
      this.query$.pipe(debounceTime(400), distinctUntilChanged()).subscribe((value) => {
        if (value.trim().length >= 2) {
          this.runSearch();
        }
      })
    );

    if (this.query) {
      this.runSearch(title);
    }
  }

  ngOnDestroy(): void {
    this.searchSub?.unsubscribe();
    this.articleSub?.unsubscribe();
    this.subs.forEach((s) => s.unsubscribe());
  }

  onQueryChanged(): void {
    this.query$.next(this.query);
  }

  onLangChanged(): void {
    if (this.query.trim()) {
      this.runSearch();
    }
  }

  submitSearch(): void {
    if (!this.query.trim()) {
      return;
    }
    this.runSearch();
  }

  clearSearch(): void {
    this.searchSub?.unsubscribe();
    this.articleSub?.unsubscribe();
    this.query = '';
    this.results = [];
    this.selectedKey = null;
    this.article = null;
    this.searched = false;
    this.errorMessage = '';
    this.searching = false;
    this.loadingArticle = false;
    this.syncUrl();
  }

  selectResult(page: WikipediaSearchPage): void {
    const title = page.title || page.key;
    if (!title) {
      return;
    }
    this.selectedKey = page.key || page.title || title;
    this.loadArticle(title);
    this.syncUrl();
  }

  articleTitle(): string {
    if (!this.article) {
      return '';
    }
    return this.stripMarkup(this.article.displaytitle || this.article.title || '');
  }

  articleImage(): string | null {
    return this.article?.originalimage?.source || this.article?.thumbnail?.source || null;
  }

  articleUrl(): string | null {
    return this.article?.content_urls?.desktop?.page || this.article?.content_urls?.mobile?.page || null;
  }

  isDisambiguation(): boolean {
    return this.article?.type === 'disambiguation';
  }

  isRtl(): boolean {
    return this.lang === 'ar' || this.lang === 'he';
  }

  resultThumb(page: WikipediaSearchPage): string | null {
    return page.thumbnailUrl || null;
  }

  private runSearch(preferTitle?: string | null): void {
    const q = this.query.trim();
    if (!q) {
      return;
    }
    this.searchSub?.unsubscribe();
    this.articleSub?.unsubscribe();
    this.searching = true;
    this.searched = true;
    this.errorMessage = '';
    this.results = [];
    this.selectedKey = preferTitle || null;
    this.article = null;
    this.syncUrl(preferTitle);

    this.searchSub = this.api.searchWikipedia(q, this.lang, 12).subscribe({
      next: (res) => {
        this.results = res?.pages || [];
        this.searching = false;
        if (this.results.length) {
          const preferred = preferTitle
            ? this.results.find((p) => this.sameTitle(p, preferTitle))
            : null;
          this.selectResult(preferred || this.results[0]);
          return;
        }
        this.loadArticle(q);
      },
      error: () => {
        this.searching = false;
        this.results = [];
        this.errorMessage = 'WIKI.ERROR';
      }
    });
  }

  private loadArticle(title: string): void {
    this.articleSub?.unsubscribe();
    this.loadingArticle = true;
    this.article = null;
    this.articleSub = this.api.getWikipediaSummary(title, this.lang).subscribe({
      next: (summary) => {
        this.loadingArticle = false;
        if (summary && (summary.extract || summary.description || summary.title)) {
          this.article = summary;
          if (!this.selectedKey) {
            this.selectedKey = summary.title || title;
          }
        } else if (!this.results.length) {
          this.errorMessage = 'WIKI.NO_RESULTS';
        }
      },
      error: () => {
        this.loadingArticle = false;
        if (!this.results.length) {
          this.errorMessage = 'WIKI.ERROR';
        }
      }
    });
  }

  private syncUrl(title?: string | null): void {
    const selected = title || this.selectedKey;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q: this.query.trim() || null,
        lang: this.lang || null,
        title: selected || null
      },
      replaceUrl: true
    });
  }

  private sameTitle(page: WikipediaSearchPage, title: string): boolean {
    const wanted = this.normalizeTitle(title);
    return this.normalizeTitle(page.title || '') === wanted
      || this.normalizeTitle(page.key || '') === wanted;
  }

  private normalizeTitle(value: string): string {
    return value.trim().replace(/ /g, '_').toLowerCase();
  }

  private normalizeLang(lang: string): string {
    const raw = (lang || 'fr').trim().toLowerCase();
    const mapped = raw.startsWith('jp') ? 'ja'
      : raw.startsWith('cn') ? 'zh'
      : raw.startsWith('in') ? 'hi'
      : raw.slice(0, 2);
    return this.langs.some((l) => l.code === mapped) ? mapped : 'en';
  }

  private stripMarkup(value: string): string {
    return value.replace(/<[^>]+>/g, '').trim();
  }
}
