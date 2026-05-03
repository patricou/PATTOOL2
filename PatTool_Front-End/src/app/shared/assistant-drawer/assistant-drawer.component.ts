import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewChecked,
  AfterViewInit,
  HostListener,
  OnDestroy,
  OnInit,
  ChangeDetectorRef,
  SecurityContext
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NavigationEnd, Router } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { combineLatest, filter, Subscription } from 'rxjs';
import { KeycloakService } from '../../keycloak/keycloak.service';
import {
  AssistantChatMeta,
  AssistantChatTurn,
  AssistantOpenAiCredits,
  AssistantService,
  parseElapsedMsFromAssistantResponse
} from '../../services/assistant.service';
import { AssistantSessionStore } from '../../services/assistant-session.store';
import { AssistantLaunchService } from '../../services/assistant-launch.service';
import { marked, setOptions } from 'marked';
import { NewsTickerService } from '../../services/news-ticker.service';
import { CurrencyTickerService } from '../../services/currency-ticker.service';
import { StockTickerService } from '../../services/stock-ticker.service';

@Component({
  selector: 'app-assistant-drawer',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './assistant-drawer.component.html',
  styleUrls: ['./assistant-drawer.component.css']
})
export class AssistantDrawerComponent
  implements AfterViewInit, AfterViewChecked, OnInit, OnDestroy
{
  @ViewChild('threadEl') threadEl?: ElementRef<HTMLDivElement>;
  @ViewChild('draftInput') draftInputEl?: ElementRef<HTMLTextAreaElement>;

  /** Juste sous la bande bleue `.pat-title` (ou minimum sous navbar + tickers). */
  fabTopPx = 72;

  isOpen = false;
  fullscreen = false;
  draft = '';
  loading = false;
  messages: AssistantChatTurn[] = [];
  private shouldAlignLastQuestionTop = false;

  /** Détail du solde crédits API (bouton titre). */
  creditsBannerOpen = false;
  creditsLoading = false;
  credits: AssistantOpenAiCredits | null = null;

  /** Dernier pixel de la navbar PatTool (~ --navbar-height). */
  private static readonly NAV_BOTTOM_PX = 60;
  private static readonly FAB_GAP_PX = 12;
  /** Espace entre le bas de `.pat-title` et le centre vertical du bouton. */
  private static readonly FAB_UNDER_TITLE_GAP_PX = 10;

  private tickerLayoutSub?: Subscription;
  private routerSub?: Subscription;
  private assistantLaunchSub?: Subscription;
  private fabAnchorRaf = 0;
  private draftPersistTimer?: ReturnType<typeof setTimeout>;
  private readonly boundScheduleFabAnchor = (): void => this.scheduleFabAnchorUpdate();

  constructor(
    private keycloak: KeycloakService,
    private assistant: AssistantService,
    private assistantSession: AssistantSessionStore,
    private assistantLaunch: AssistantLaunchService,
    private router: Router,
    private newsTicker: NewsTickerService,
    private currencyTicker: CurrencyTickerService,
    private stockTicker: StockTickerService,
    private cdr: ChangeDetectorRef,
    private translate: TranslateService,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    setOptions({ breaks: true, gfm: true });

    this.tickerLayoutSub = combineLatest([
      this.newsTicker.enabled$,
      this.currencyTicker.enabled$,
      this.stockTicker.enabled$
    ]).subscribe(() => this.scheduleFabAnchorUpdate());

    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => {
        this.scheduleFabAnchorUpdate();
        setTimeout(() => this.scheduleFabAnchorUpdate(), 0);
        setTimeout(() => this.scheduleFabAnchorUpdate(), 140);
      });

    window.addEventListener('resize', this.boundScheduleFabAnchor, { passive: true });
    document.addEventListener('scroll', this.boundScheduleFabAnchor, { passive: true, capture: true });

    this.scheduleFabAnchorUpdate();
    if (this.isAuthenticated()) {
      const saved = this.assistantSession.load();
      if (saved != null) {
        this.messages = saved.messages;
        this.draft = saved.draft;
      }
    }

    this.assistantLaunchSub = this.assistantLaunch.launches$.subscribe((p) => {
      if (!this.isAuthenticated() || !p.draft?.trim()) {
        return;
      }
      this.draft = p.draft.trim();
      this.isOpen = true;
      this.fullscreen = false;
      this.persistSession();
      this.scheduleFabAnchorUpdate();
      this.cdr.detectChanges();
      queueMicrotask(() => this.requestAlignLastQuestionTop());
    });
  }

  ngAfterViewInit(): void {
    queueMicrotask(() => this.scheduleFabAnchorUpdate());
    setTimeout(() => this.scheduleFabAnchorUpdate(), 0);
    setTimeout(() => this.scheduleFabAnchorUpdate(), 120);
  }

  /** Fournisseur et modèle (réponse succès uniquement si le backend les envoie). */
  replyProviderModelLine(m: AssistantChatTurn): string {
    if (m.role !== 'assistant') {
      return '';
    }
    const meta = m.meta;
    const provider =
      typeof meta?.provider === 'string' ? meta.provider.trim() : '';
    const model =
      typeof meta?.model === 'string' ? meta.model.trim() : '';
    const parts = [provider, model].filter((x) => x.length > 0);
    return parts.join(' · ');
  }

  replyStatsLine(m: AssistantChatTurn): string {
    if (m.role !== 'assistant') {
      return '';
    }
    const meta = m.meta;
    const tin = meta?.inputTokens;
    const tout = meta?.outputTokens;
    const elapsedMs =
      meta?.elapsedMs != null &&
      typeof meta.elapsedMs === 'number' &&
      Number.isFinite(meta.elapsedMs) &&
      meta.elapsedMs >= 0
        ? Math.round(meta.elapsedMs)
        : undefined;
    const hasTokens =
      (tin != null && tin >= 0) || (tout != null && tout >= 0);
    const i = tin ?? 0;
    const o = tout ?? 0;

    if (elapsedMs != null && hasTokens) {
      return this.translate.instant('ASSISTANT.STAT_MS_AND_TOKENS', {
        ms: elapsedMs,
        total: i + o,
        in: i,
        out: o
      });
    }
    if (hasTokens) {
      return this.translate.instant('ASSISTANT.STAT_TOKENS', {
        total: i + o,
        in: i,
        out: o
      });
    }
    if (elapsedMs != null) {
      return this.translate.instant('ASSISTANT.STAT_MS', { ms: elapsedMs });
    }
    return '';
  }

  toggleCreditsBanner(ev?: MouseEvent): void {
    ev?.stopPropagation();
    this.creditsBannerOpen = !this.creditsBannerOpen;
    if (this.creditsBannerOpen) {
      this.fetchOpenAiCredits();
    }
  }

  fetchOpenAiCredits(): void {
    if (!this.isAuthenticated()) {
      return;
    }
    this.creditsLoading = true;
    this.cdr.detectChanges();
    this.assistant.getOpenAiCredits().subscribe({
      next: (c) => {
        this.creditsLoading = false;
        this.credits = c;
        this.cdr.detectChanges();
      },
      error: () => {
        this.creditsLoading = false;
        this.credits = {
          ok: false,
          message: this.translate.instant('ASSISTANT.CREDITS_NETWORK_ERROR')
        };
        this.cdr.detectChanges();
      }
    });
  }

  ngOnDestroy(): void {
    this.persistSession();
    if (this.draftPersistTimer !== undefined) {
      clearTimeout(this.draftPersistTimer);
    }
    this.tickerLayoutSub?.unsubscribe();
    this.routerSub?.unsubscribe();
    this.assistantLaunchSub?.unsubscribe();
    window.removeEventListener('resize', this.boundScheduleFabAnchor);
    document.removeEventListener('scroll', this.boundScheduleFabAnchor, true);
    if (this.fabAnchorRaf) {
      cancelAnimationFrame(this.fabAnchorRaf);
    }
  }

  /** sessionStorage pour cet utilisateur jusqu’à fermeture de l’onglet. */
  private persistSession(): void {
    if (!this.isAuthenticated()) {
      return;
    }
    this.assistantSession.save(this.messages, this.draft ?? '');
  }

  /** Frappe dans la zone : reporte l’autosauvegarde du brouillon. */
  onDraftDebouncedPersist(): void {
    if (!this.isAuthenticated()) {
      return;
    }
    if (this.draftPersistTimer !== undefined) {
      clearTimeout(this.draftPersistTimer);
    }
    this.draftPersistTimer = setTimeout(() => {
      this.draftPersistTimer = undefined;
      this.persistSession();
    }, 450);
  }

  /** Recalcule la position fixed du bouton sous `.pat-title` (viewport). */
  private scheduleFabAnchorUpdate(): void {
    if (this.fabAnchorRaf !== 0) {
      return;
    }
    this.fabAnchorRaf = requestAnimationFrame(() => {
      this.fabAnchorRaf = 0;
      this.updateFabAnchor();
    });
  }

  /** Choisir le bandeau `.pat-title` réellement visible (évite le premier nœud caché / hors viewport). */
  private static resolvePatTitleForFabAnchor(): HTMLElement | null {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return null;
    }
    const titles = Array.from(document.querySelectorAll('.pat-title')).filter(
      (n): n is HTMLElement => n instanceof HTMLElement
    );
    if (titles.length === 0) {
      return null;
    }
    const vh = window.innerHeight;
    let best: HTMLElement | null = null;
    let bestOverlap = -1;

    for (const el of titles) {
      let cs: CSSStyleDeclaration | null = null;
      try {
        cs = getComputedStyle(el);
      } catch {
        cs = null;
      }
      if (cs != null && (cs.display === 'none' || cs.visibility === 'hidden')) {
        continue;
      }

      let r: DOMRect;
      try {
        r = el.getBoundingClientRect();
      } catch {
        continue;
      }
      if (r.height < 3 || r.width < 3) {
        continue;
      }

      const visibleTop = Math.max(0, r.top);
      const visibleBottom = Math.min(vh, r.bottom);
      const overlap = Math.max(0, visibleBottom - visibleTop);

      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = el;
      } else if (overlap === bestOverlap && overlap > 0 && best != null) {
        const bt = best.getBoundingClientRect().top;
        if (r.top < bt) {
          best = el;
        }
      }
    }

    return best ?? titles[titles.length - 1];
  }

  private updateFabAnchor(): void {
    const minTop = AssistantDrawerComponent.computeFabTopBelowNavAndTickers(
      this.newsTicker.isEnabled,
      this.currencyTicker.isEnabled,
      this.stockTicker.isEnabled
    );
    const title = AssistantDrawerComponent.resolvePatTitleForFabAnchor();
    let next = minTop;
    if (title) {
      const bottom = title.getBoundingClientRect().bottom;
      next = Math.max(
        minTop,
        Math.round(bottom + AssistantDrawerComponent.FAB_UNDER_TITLE_GAP_PX)
      );
    }
    if (next !== this.fabTopPx) {
      this.fabTopPx = next;
      this.cdr.markForCheck();
    }
  }

  /** Même empilement que les CSS news/currency/stock ticker (anchors à 56px). */
  private static computeFabTopBelowNavAndTickers(
    news: boolean,
    currency: boolean,
    stock: boolean
  ): number {
    let stackBottom = AssistantDrawerComponent.NAV_BOTTOM_PX;
    if (news) {
      stackBottom = Math.max(stackBottom, 112);
    }
    if (currency) {
      const currencyTop = news ? 112 : 56;
      stackBottom = Math.max(stackBottom, currencyTop + 40);
    }
    if (stock) {
      let stockTop = 56;
      if (news && currency) {
        stockTop = 152;
      } else if (news) {
        stockTop = 112;
      } else if (currency) {
        stockTop = 96;
      }
      stackBottom = Math.max(stackBottom, stockTop + 40);
    }
    return stackBottom + AssistantDrawerComponent.FAB_GAP_PX;
  }

  isAuthenticated(): boolean {
    return this.keycloak.isLoggedIn();
  }

  /** Libellé utilisateur (bulles + placeholder) : preferred_username Keycloak, sinon prénom/nom ou e-mail. */
  chatUserLabel(): string {
    const authz: any = this.keycloak.getAuth();
    const tp = authz?.tokenParsed;
    if (!tp || typeof tp !== 'object') {
      return '';
    }
    const u = typeof tp.preferred_username === 'string' ? tp.preferred_username.trim() : '';
    if (u) {
      return u;
    }
    const fn = typeof tp.given_name === 'string' ? tp.given_name.trim() : '';
    const ln = typeof tp.family_name === 'string' ? tp.family_name.trim() : '';
    const full = [fn, ln].filter(Boolean).join(' ').trim();
    if (full) {
      return full;
    }
    const em = typeof tp.email === 'string' ? tp.email.trim() : '';
    if (em) {
      const at = em.indexOf('@');
      return at > 0 ? em.slice(0, at) : em;
    }
    return '';
  }

  /** Index du dernier message utilisateur (question posée la plus récente). */
  lastUserMessageIndex(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        return i;
      }
    }
    return -1;
  }

  /**
   * Bulle : Markdown pour l’assistant (gras, italique, listes, code…), liens + sauts de ligne pour l’utilisateur.
   */
  messageRichHtml(m: AssistantChatTurn): SafeHtml {
    if (m.role === 'assistant') {
      return this.assistantMarkdownHtml(m.content);
    }
    return this.linkRichContent(m.content);
  }

  /**
   * Corps de message enrichi : texte échappé, retours ligne → br, URLs http(s) cliquables.
   */
  linkRichContent(text: string | null | undefined): SafeHtml {
    if (text == null || text === '') {
      return this.sanitizer.bypassSecurityTrustHtml('');
    }
    const s = String(text);
    const re = /\b(https?:\/\/[^\s<>"']+)/gi;
    let built = '';
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(s)) !== null) {
      const idx = match.index;
      const full = match[0];
      built += this.escapeHtmlBasic(s.slice(last, idx));
      let url = full;
      let punctTail = '';
      const trailChars = `.,;:!?)]}'"`;
      while (url.length > 0 && trailChars.includes(url.charAt(url.length - 1))) {
        punctTail = url.slice(-1) + punctTail;
        url = url.slice(0, -1);
      }
      let href = url;
      try {
        href = encodeURI(url);
      } catch {
        href = url;
      }
      built +=
        '<a class="pat-assistant-link" href="' +
        this.escapeHtmlAttr(href) +
        '" target="_blank" rel="noopener noreferrer">' +
        this.escapeHtmlBasic(url) +
        '</a>';
      built += this.escapeHtmlBasic(punctTail);
      last = idx + full.length;
    }
    built += this.escapeHtmlBasic(s.slice(last));
    built = built.replace(/\r\n|\r|\n/g, '<br>');
    return this.sanitizer.bypassSecurityTrustHtml(built);
  }

  /** Markdown → HTML sanitisé (réponses modèle). */
  private assistantMarkdownHtml(text: string | null | undefined): SafeHtml {
    if (text == null || text === '') {
      return this.sanitizer.bypassSecurityTrustHtml('');
    }
    let raw: string;
    try {
      raw = marked(String(text), { async: false });
    } catch {
      return this.linkRichContent(text);
    }
    const wrapped = '<div class="pat-assistant-md">' + raw + '</div>';
    const cleaned = this.sanitizer.sanitize(SecurityContext.HTML, wrapped);
    return this.sanitizer.bypassSecurityTrustHtml(cleaned ?? '');
  }

  private escapeHtmlBasic(t: string): string {
    return t
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private escapeHtmlAttr(t: string): string {
    return this.escapeHtmlBasic(t).replace(/\r?\n/g, ' ');
  }

  /** Recopie une question précédente dans le champ du bas (pour relancer ou modifier). */
  copyQuestionIntoDraft(content: string, ev: MouseEvent): void {
    ev.stopPropagation();
    ev.preventDefault();
    const text = typeof content === 'string' ? content : '';
    if (this.loading) {
      return;
    }
    this.draft = text;
    if (this.draftPersistTimer !== undefined) {
      clearTimeout(this.draftPersistTimer);
      this.draftPersistTimer = undefined;
    }
    this.persistSession();
    this.cdr.detectChanges();
    queueMicrotask(() => {
      const el = this.draftInputEl?.nativeElement;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
  }

  ngAfterViewChecked(): void {
    if (!this.shouldAlignLastQuestionTop || !this.threadEl) {
      return;
    }
    const wrap = this.threadEl.nativeElement;
    const anchor = wrap.querySelector(
      '.pat-assistant-bubble--anchor-last-q'
    ) as HTMLElement | null;
    if (anchor) {
      const desiredTop =
        anchor.getBoundingClientRect().top -
        wrap.getBoundingClientRect().top +
        wrap.scrollTop;
      wrap.scrollTop = Math.max(0, desiredTop - 4);
    }
    this.shouldAlignLastQuestionTop = false;
  }

  toggle(): void {
    if (!this.isAuthenticated()) {
      return;
    }
    this.isOpen = !this.isOpen;
    if (!this.isOpen) {
      this.creditsBannerOpen = false;
      return;
    }
    if (this.messages.length > 0) {
      queueMicrotask(() => this.requestAlignLastQuestionTop());
    }
  }

  close(): void {
    this.persistSession();
    this.isOpen = false;
    this.fullscreen = false;
    this.creditsBannerOpen = false;
  }

  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    if (this.messages.length > 0) {
      queueMicrotask(() => this.requestAlignLastQuestionTop());
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.isOpen) {
      return;
    }
    if (this.fullscreen) {
      this.fullscreen = false;
      return;
    }
    this.close();
  }

  clearThread(): void {
    this.messages = [];
    this.draft = '';
    this.persistSession();
  }

  /** Réinitialisation possible s'il y a du contenu à effacer (historique ou brouillon). */
  hasAnythingToReset(): boolean {
    return (
      this.messages.length > 0 ||
      (!!this.draft && this.draft.trim().length > 0)
    );
  }

  send(): void {
    const text = this.draft.trim();
    if (!text || this.loading || !this.isAuthenticated()) {
      return;
    }
    this.draft = '';
    const userMsg: AssistantChatTurn = { role: 'user', content: text };
    this.messages = [...this.messages, userMsg];
    this.persistSession();
    this.requestAlignLastQuestionTop();
    this.loading = true;

    const payload = this.messages.map((m) => ({
      role: m.role,
      content: m.content
    }));

    this.assistant.sendMessages(payload).subscribe({
      next: (res) => {
        this.loading = false;
        const buildMetaFromRes = (): AssistantChatMeta | undefined => {
          const meta: AssistantChatMeta = {};
          const elapsedMs = parseElapsedMsFromAssistantResponse(res);
          if (elapsedMs != null) {
            meta.elapsedMs = elapsedMs;
          }
          if (res.inputTokens != null) {
            meta.inputTokens = res.inputTokens;
          }
          if (res.outputTokens != null) {
            meta.outputTokens = res.outputTokens;
          }
          const prov =
            typeof res.provider === 'string' ? res.provider.trim() : '';
          if (prov) {
            meta.provider = prov;
          }
          const mod =
            typeof res.model === 'string' ? res.model.trim() : '';
          if (mod) {
            meta.model = mod;
          }
          return Object.keys(meta).length ? meta : undefined;
        };
        if (res.error) {
          const meta = buildMetaFromRes();
          this.messages = [
            ...this.messages,
            {
              role: 'assistant',
              content: res.error,
              ...(meta ? { meta } : {})
            }
          ];
        } else {
          const answer =
            res.content != null && res.content.length > 0
              ? res.content
              : '(Réponse vide)';
          const meta = buildMetaFromRes();
          this.messages = [
            ...this.messages,
            {
              role: 'assistant',
              content: answer,
              ...(meta ? { meta } : {})
            }
          ];
        }
        this.requestAlignLastQuestionTop();
        this.persistSession();
      },
      error: () => {
        this.loading = false;
        this.messages = [
          ...this.messages,
          {
            role: 'assistant',
            content: 'Erreur réseau ou serveur. Réessayez plus tard.'
          }
        ];
        this.requestAlignLastQuestionTop();
        this.persistSession();
      }
    });
  }

  onTextareaKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      this.send();
    }
  }

  private requestAlignLastQuestionTop(): void {
    this.shouldAlignLastQuestionTop = true;
  }
}
