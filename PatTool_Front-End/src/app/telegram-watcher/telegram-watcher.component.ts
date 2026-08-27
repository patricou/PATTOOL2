import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import {
  ApiService,
  TelegramChat,
  TelegramEmbed,
  TelegramInbox,
  TelegramMessage,
  TelegramStatus
} from '../services/api.service';

@Component({
  selector: 'app-telegram-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './telegram-watcher.component.html',
  styleUrls: ['./telegram-watcher.component.css']
})
export class TelegramWatcherComponent implements OnInit, OnDestroy {
  status: TelegramStatus | null = null;
  chats: TelegramChat[] = [];
  selectedChatId: string | null = null;
  draft = '';
  botToken = '';
  postUrl = '';
  embed: TelegramEmbed | null = null;
  embedSafeUrl: SafeResourceUrl | null = null;

  connecting = false;
  disconnecting = false;
  loadingInbox = false;
  sending = false;
  embedding = false;
  searchedEmbed = false;

  errorMessage = '';
  connectError = '';
  sendError = '';
  embedError = '';
  inviteCopied = false;

  readonly mediaUrls = new Map<string, string>();
  private readonly subs: Subscription[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler?: () => void;
  private inviteCopiedTimer: ReturnType<typeof setTimeout> | null = null;

  @ViewChild('threadEnd') threadEnd?: ElementRef<HTMLElement>;

  constructor(
    private api: ApiService,
    private sanitizer: DomSanitizer,
    private translate: TranslateService
  ) {}

  ngOnInit(): void {
    this.loadStatus(true);
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible' && this.status?.connected) {
        this.refreshInbox();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.subs.forEach((s) => s.unsubscribe());
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.revokeMedia();
    if (this.inviteCopiedTimer) {
      clearTimeout(this.inviteCopiedTimer);
    }
  }

  get selectedChat(): TelegramChat | null {
    if (!this.selectedChatId) {
      return this.chats[0] || null;
    }
    return this.chats.find((c) => c.id === this.selectedChatId) || this.chats[0] || null;
  }

  get selectedMessages(): TelegramMessage[] {
    return this.selectedChat?.messages || [];
  }

  connect(): void {
    const token = this.botToken.trim();
    if (!token || this.connecting) {
      return;
    }
    this.connecting = true;
    this.connectError = '';
    this.subs.push(
      this.api.connectTelegram(token).subscribe({
        next: (status) => {
          this.connecting = false;
          this.status = status;
          this.botToken = '';
          if (status.connected) {
            this.startPolling();
            this.refreshInbox();
          } else {
            this.connectError = this.errorKey(status.error, 'TELEGRAM.ERROR_INVALID_TOKEN');
          }
        },
        error: (err) => {
          this.connecting = false;
          const body = err?.error as TelegramStatus | undefined;
          this.connectError = this.errorKey(body?.error, 'TELEGRAM.ERROR_INVALID_TOKEN');
        }
      })
    );
  }

  disconnect(): void {
    if (this.disconnecting) {
      return;
    }
    this.disconnecting = true;
    this.subs.push(
      this.api.disconnectTelegram().subscribe({
        next: () => {
          this.disconnecting = false;
          this.status = { connected: false };
          this.chats = [];
          this.selectedChatId = null;
          this.stopPolling();
          this.revokeMedia();
        },
        error: () => {
          this.disconnecting = false;
          this.errorMessage = 'TELEGRAM.ERROR';
        }
      })
    );
  }

  selectChat(chat: TelegramChat): void {
    this.selectedChatId = chat.id || null;
    this.sendError = '';
    this.queueMediaLoads(chat.messages || []);
    this.scrollThread();
  }

  send(): void {
    const chat = this.selectedChat;
    const text = this.draft.trim();
    if (!chat?.id || !text || this.sending) {
      return;
    }
    this.sending = true;
    this.sendError = '';
    this.subs.push(
      this.api.sendTelegramMessage(chat.id, text).subscribe({
        next: (inbox) => {
          this.sending = false;
          this.draft = '';
          this.applyInbox(inbox);
          this.scrollThread();
        },
        error: (err) => {
          this.sending = false;
          const body = err?.error as TelegramInbox | undefined;
          this.sendError = this.errorKey(body?.error, 'TELEGRAM.ERROR_SEND');
        }
      })
    );
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  embedPost(): void {
    const url = this.postUrl.trim();
    if (!url || this.embedding) {
      return;
    }
    this.embedding = true;
    this.embedError = '';
    this.searchedEmbed = true;
    this.subs.push(
      this.api.embedTelegramPost(url).subscribe({
        next: (embed) => {
          this.embedding = false;
          this.embed = embed;
          this.embedSafeUrl = embed.embedUrl
            ? this.sanitizer.bypassSecurityTrustResourceUrl(embed.embedUrl)
            : null;
        },
        error: () => {
          this.embedding = false;
          this.embed = null;
          this.embedSafeUrl = null;
          this.embedError = 'TELEGRAM.EMBED_INVALID';
        }
      })
    );
  }

  chatTitle(chat: TelegramChat | null | undefined): string {
    if (!chat) {
      return '';
    }
    if (chat.title) {
      return chat.title;
    }
    const name = `${chat.firstName || ''} ${chat.lastName || ''}`.trim();
    if (name) {
      return name;
    }
    if (chat.username) {
      return '@' + chat.username;
    }
    return chat.id || '';
  }

  lastPreview(chat: TelegramChat): string {
    const messages = chat.messages || [];
    const last = messages[messages.length - 1];
    if (!last) {
      return '';
    }
    if (last.text) {
      return last.text;
    }
    if (last.caption) {
      return last.caption;
    }
    return last.mediaKind && last.mediaKind !== 'none' ? last.mediaKind : '';
  }

  mediaUrl(fileId: string | undefined): string | null {
    if (!fileId) {
      return null;
    }
    return this.mediaUrls.get(fileId) || null;
  }

  isPhoto(msg: TelegramMessage): boolean {
    return msg.mediaKind === 'photo' || msg.mediaKind === 'sticker' || msg.mediaKind === 'animation';
  }

  isVideo(msg: TelegramMessage): boolean {
    return msg.mediaKind === 'video';
  }

  isAudio(msg: TelegramMessage): boolean {
    return msg.mediaKind === 'audio' || msg.mediaKind === 'voice';
  }

  formatTime(epoch?: number): string {
    if (!epoch) {
      return '';
    }
    const date = new Date(epoch * 1000);
    return date.toLocaleString();
  }

  botHandle(): string {
    const username = this.status?.botUsername;
    return username ? '@' + username : '';
  }

  inviteUrl(): string {
    const username = this.status?.botUsername?.trim();
    return username ? 'https://t.me/' + username : '';
  }

  shareInviteUrl(): string {
    const url = this.inviteUrl();
    if (!url) {
      return '';
    }
    const text = this.translate.instant('TELEGRAM.INVITE_SHARE_TEXT', { bot: this.botHandle() });
    return 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text);
  }

  copyInvite(): void {
    const url = this.inviteUrl();
    if (!url) {
      return;
    }
    const done = () => {
      this.inviteCopied = true;
      if (this.inviteCopiedTimer) {
        clearTimeout(this.inviteCopiedTimer);
      }
      this.inviteCopiedTimer = setTimeout(() => {
        this.inviteCopied = false;
      }, 2500);
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url).then(done).catch(() => this.fallbackCopy(url, done));
    } else {
      this.fallbackCopy(url, done);
    }
  }

  private fallbackCopy(text: string, done: () => void): void {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      // ignore
    }
    document.body.removeChild(area);
  }

  private loadStatus(loadInbox: boolean): void {
    this.subs.push(
      this.api.getTelegramConnection().subscribe({
        next: (status) => {
          this.status = status;
          if (status.connected) {
            this.startPolling();
            if (loadInbox) {
              this.refreshInbox();
            }
          }
        },
        error: () => {
          this.errorMessage = 'TELEGRAM.ERROR';
        }
      })
    );
  }

  private refreshInbox(): void {
    if (this.loadingInbox || document.visibilityState === 'hidden') {
      return;
    }
    this.loadingInbox = true;
    this.subs.push(
      this.api.getTelegramInbox().subscribe({
        next: (inbox) => {
          this.loadingInbox = false;
          this.applyInbox(inbox);
        },
        error: () => {
          this.loadingInbox = false;
        }
      })
    );
  }

  private applyInbox(inbox: TelegramInbox): void {
    if (inbox.error === 'not_connected') {
      this.status = { connected: false };
      this.chats = [];
      this.stopPolling();
      return;
    }
    if (inbox.error) {
      this.errorMessage = this.errorKey(inbox.error, 'TELEGRAM.ERROR');
    } else {
      this.errorMessage = '';
    }
    this.chats = inbox.chats || [];
    if (this.selectedChatId && !this.chats.some((c) => c.id === this.selectedChatId)) {
      this.selectedChatId = this.chats[0]?.id || null;
    }
    if (!this.selectedChatId && this.chats.length) {
      this.selectedChatId = this.chats[0].id || null;
    }
    for (const chat of this.chats) {
      this.queueMediaLoads(chat.messages || []);
    }
  }

  private queueMediaLoads(messages: TelegramMessage[]): void {
    for (const msg of messages) {
      const fileId = msg.fileId?.trim();
      if (!fileId || this.mediaUrls.has(fileId) || msg.mediaKind === 'none') {
        continue;
      }
      this.mediaUrls.set(fileId, '');
      this.subs.push(
        this.api.getTelegramFile(fileId).subscribe({
          next: (blob) => {
            const url = URL.createObjectURL(blob);
            this.mediaUrls.set(fileId, url);
          },
          error: () => {
            this.mediaUrls.delete(fileId);
          }
        })
      );
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.refreshInbox(), 4000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scrollThread(): void {
    setTimeout(() => {
      this.threadEnd?.nativeElement?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 50);
  }

  private revokeMedia(): void {
    for (const url of this.mediaUrls.values()) {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
    this.mediaUrls.clear();
  }

  private errorKey(error: string | undefined, fallback: string): string {
    switch (error) {
      case 'invalid_token':
        return 'TELEGRAM.ERROR_INVALID_TOKEN';
      case 'not_connected':
        return 'TELEGRAM.ERROR_NOT_CONNECTED';
      case 'send_failed':
      case 'invalid_text':
      case 'invalid_chat':
        return 'TELEGRAM.ERROR_SEND';
      default:
        return fallback;
    }
  }
}
