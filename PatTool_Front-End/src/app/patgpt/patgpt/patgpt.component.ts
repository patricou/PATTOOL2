import { Component, DestroyRef, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { SafeHtml } from '@angular/platform-browser';
import { ChatResponse } from '../../model/chat-response';
import { PatgptService } from '../../services/patgpt.service';
import { AssistantService } from '../../services/assistant.service';
import { MarkdownChatRenderService } from '../../services/markdown-chat-render.service';
import { copyPlainTextToClipboard } from '../../shared/clipboard-copy';
import { environment } from '../../../environments/environment';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';
import { Subscription } from 'rxjs';
import { finalize } from 'rxjs/operators';

@Component({
  selector: 'app-patgpt',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NavigationButtonsModule],
  templateUrl: './patgpt.component.html',
  styleUrls: ['./patgpt.component.css', '../../shared/markdown-chat-content.css']
})
export class PatgptComponent implements OnInit, OnDestroy {
  private readonly destroyRef = inject(DestroyRef);

  userInput: string = '';
  chatResponse: ChatResponse | null = null;
  currentDate: Date = new Date();
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private patGptRequestSub?: Subscription;
  private URL4PATGPT: string = environment.URL4PATGPT;
  sendWithHistorical: boolean = true;
  lastxquestion: boolean = true;
  public isLoading: boolean = false;

  /** Fournisseur · modèle depuis application.properties (GET /assistant/config). */
  aiConfigMetaLine = '';

  constructor(
    private patgptService: PatgptService,
    private assistantConfig: AssistantService,
    private mdChat: MarkdownChatRenderService
  ) { }

  ngOnInit() {
    this.intervalId = setInterval(() => {
      this.currentDate = new Date();
    }, 1000);
    this.assistantConfig
      .getAssistantClientConfig()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (c) => {
          const p = typeof c.provider === 'string' ? c.provider.trim() : '';
          const m = typeof c.model === 'string' ? c.model.trim() : '';
          this.aiConfigMetaLine = [p, m].filter((x) => x.length > 0).join(' · ');
        }
      });
  }

  ngOnDestroy(): void {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.patGptRequestSub?.unsubscribe();
  }

  sendQuestion() {
    this.patGptRequestSub?.unsubscribe();
    this.isLoading = true;
    this.chatResponse = null;
    this.patGptRequestSub = this.patgptService
      .getPatGptResponse(this.userInput, this.sendWithHistorical, this.lastxquestion)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.isLoading = false;
        })
      )
      .subscribe({
        next: (response) => {
          this.chatResponse = response;
        },
        error: () => {
          this.chatResponse = null;
        }
      });
  }

  onUserInput(event: Event) {
    this.userInput = (event.target as HTMLTextAreaElement).value;
  }

  clearTextArea(): void {
    this.userInput = '';
  }

  navigateToHistorical(): void {
    window.open(this.URL4PATGPT + "h2-console", '_blank');
  }

  patGptAnswerHtml(): SafeHtml {
    const raw = this.chatResponse?.choices?.[0]?.message?.content;
    return this.mdChat.renderModelReply(raw) ?? this.mdChat.renderPlainFallback(raw ?? '');
  }

  patGptAnswerPlain(): string {
    const raw = this.chatResponse?.choices?.[0]?.message?.content;
    return typeof raw === 'string' ? raw : '';
  }

  copyPatGptAnswer(ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    copyPlainTextToClipboard(this.patGptAnswerPlain());
  }

  /** Sous-titre carte : config serveur (properties), sinon réponse API. */
  patGptHeaderMeta(): string {
    if (this.aiConfigMetaLine) {
      return this.aiConfigMetaLine;
    }
    const model = this.chatResponse?.model?.trim();
    if (!model) {
      return '';
    }
    return `OpenAI · ${model}`;
  }

  clearHistorical(): void {
    this.chatResponse = null;
    this.userInput = '';
    const response = confirm("New discussion ? ( You are going to delete the historical ).");
    if (response) {
      this.patgptService
        .delPatGptHistorical()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    }
  }

}