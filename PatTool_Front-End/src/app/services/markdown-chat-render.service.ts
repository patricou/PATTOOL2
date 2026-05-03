import { Injectable, SecurityContext } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';

let patMarkdownMarkedConfigured = false;

function ensurePatMarkdownMarked(): void {
  if (patMarkdownMarkedConfigured) {
    return;
  }
  marked.use({
    breaks: true,
    hooks: {
      postprocess(html: string): string {
        if (!/<a\s+href=/i.test(html)) {
          return html;
        }
        return html.replace(
          /<a href=/gi,
          '<a target="_blank" rel="noopener noreferrer" class="pat-assistant-md-a" href='
        );
      },
    },
  });
  patMarkdownMarkedConfigured = true;
}

/**
 * Rendu Markdown (GFM) pour réponses modèle : tableaux, listes, code, emphase, liens sécurisés.
 * Retourne null si le parse échoue (l’appelant peut retomber sur du texte + liens auto).
 */
@Injectable({ providedIn: 'root' })
export class MarkdownChatRenderService {
  constructor(private readonly sanitizer: DomSanitizer) {
    ensurePatMarkdownMarked();
  }

  renderModelReply(content: string | null | undefined): SafeHtml | null {
    if (content == null || content === '') {
      return this.sanitizer.bypassSecurityTrustHtml('');
    }
    let raw: string;
    try {
      raw = marked.parse(String(content), { async: false }) as string;
    } catch {
      return null;
    }
    const wrapped = '<div class="pat-assistant-md">' + raw + '</div>';
    const cleaned = this.sanitizer.sanitize(SecurityContext.HTML, wrapped);
    if (cleaned == null || cleaned === '') {
      return null;
    }
    return this.sanitizer.bypassSecurityTrustHtml(cleaned);
  }

  /** Fallback PatGPT / affichage sûr sans lien automatique. */
  renderPlainFallback(content: string | null | undefined): SafeHtml {
    if (content == null || content === '') {
      return this.sanitizer.bypassSecurityTrustHtml('');
    }
    const esc = String(content)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const html =
      '<div class="pat-assistant-md pat-assistant-md--plain"><p>' +
      esc.replace(/\r\n|\r|\n/g, '<br>') +
      '</p></div>';
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}
