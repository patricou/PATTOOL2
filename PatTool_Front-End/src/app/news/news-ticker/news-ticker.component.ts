import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import { environment } from '../../../environments/environment';
import { NewsTickerService, TickerArticle } from '../../services/news-ticker.service';

/**
 * Global scrolling news banner. Mounted once by <app-root> so it appears on
 * every route when enabled. Visibility and content are driven entirely by
 * {@link NewsTickerService}; this component only handles presentation.
 *
 * Layout: two rows of articles that scroll horizontally (marquee-style) in
 * opposite directions for a livelier effect. Each row duplicates its items
 * so the animation loops seamlessly.
 */
@Component({
  selector: 'app-news-ticker',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './news-ticker.component.html',
  styleUrls: ['./news-ticker.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class NewsTickerComponent implements OnDestroy {

  enabled = false;
  loading = false;
  rowOne: TickerArticle[] = [];
  rowTwo: TickerArticle[] = [];

  private readonly imageProxyBase = environment.API_URL + 'external/news/image?u=';
  /** Original image URLs whose proxied fetch failed; fall back to the icon. */
  private readonly failedImages = new Set<string>();

  private subs: Subscription[] = [];

  constructor(private ticker: NewsTickerService, private cdr: ChangeDetectorRef) {
    this.subs.push(
      this.ticker.enabled$.subscribe((v) => {
        this.enabled = v;
        this.cdr.markForCheck();
      }),
      this.ticker.articles$.subscribe((articles) => {
        this.splitRows(articles);
        this.cdr.markForCheck();
      }),
      this.ticker.loading$.subscribe((v) => {
        this.loading = v;
        this.cdr.markForCheck();
      })
    );
  }

  hasArticles(): boolean {
    return this.rowOne.length > 0 || this.rowTwo.length > 0;
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  trackByIndex(i: number): number {
    return i;
  }

  /** Returns the backend-proxied URL of the article thumbnail, or '' if none. */
  getThumbUrl(article: TickerArticle): string {
    if (!article.imageUrl) return '';
    return this.imageProxyBase + encodeURIComponent(article.imageUrl);
  }

  /** True if we have a usable image URL and it has not failed to load yet. */
  shouldShowThumb(article: TickerArticle): boolean {
    return !!article.imageUrl && !this.failedImages.has(article.imageUrl);
  }

  /** Called when an img tag errors; remember the URL so future renders skip it. */
  onThumbError(article: TickerArticle): void {
    if (article.imageUrl) {
      this.failedImages.add(article.imageUrl);
      this.cdr.markForCheck();
    }
  }

  /**
   * Split the articles into two alternating rows so both rows look busy even
   * with few articles. Each row is doubled in the template to make the CSS
   * animation loop without a visible gap.
   */
  private splitRows(articles: TickerArticle[]): void {
    const a: TickerArticle[] = [];
    const b: TickerArticle[] = [];
    articles.forEach((article, idx) => {
      (idx % 2 === 0 ? a : b).push(article);
    });
    this.rowOne = a;
    this.rowTwo = b.length > 0 ? b : a;
  }
}
