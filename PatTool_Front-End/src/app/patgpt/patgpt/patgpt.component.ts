import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { SafeHtml } from '@angular/platform-browser';
import { ChatResponse } from '../../model/chat-response';
import { PatgptService } from '../../services/patgpt.service';
import { AssistantService } from '../../services/assistant.service';
import { MarkdownChatRenderService } from '../../services/markdown-chat-render.service';
import { environment } from '../../../environments/environment';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';

@Component({
  selector: 'app-patgpt',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NavigationButtonsModule],
  templateUrl: './patgpt.component.html',
  styleUrls: ['./patgpt.component.css', '../../shared/markdown-chat-content.css']
})
export class PatgptComponent implements OnInit {

  userInput: string = '';
  chatResponse: ChatResponse | null = null;
  currentDate: Date = new Date();
  private intervalId: any;
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
    this.assistantConfig.getAssistantClientConfig().subscribe((c) => {
      const p = typeof c.provider === 'string' ? c.provider.trim() : '';
      const m = typeof c.model === 'string' ? c.model.trim() : '';
      this.aiConfigMetaLine = [p, m].filter((x) => x.length > 0).join(' · ');
    });
  }

  sendQuestion() {
    this.isLoading = true;
    this.chatResponse = null;
    this.patgptService.getPatGptResponse(this.userInput, this.sendWithHistorical, this.lastxquestion).subscribe(response => {
      this.isLoading = false;
      this.chatResponse = response;
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
      this.patgptService.delPatGptHistorical().subscribe(response => {

      });
    }
  }

}