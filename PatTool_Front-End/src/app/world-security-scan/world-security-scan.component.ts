import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { EMPTY } from 'rxjs';
import { finalize, catchError } from 'rxjs/operators';
import { of } from 'rxjs';
import {
  ApiService,
  PassiveCheckRow,
  PassiveProbeResponse,
  SecurityAwarenessLinksDto
} from '../services/api.service';

/**
 * Onglet « Scan sécurité » : sensibilisation PatTool, périmètre autorisé, et sonde HTTP pilotée par le backend.
 * Les résultats de la sonde sont des indicateurs (en-têtes, TLS, fichiers bien connus), pas un rapport de pentest.
 */
@Component({
  selector: 'app-world-security-scan',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './world-security-scan.component.html',
  styleUrls: ['./world-security-scan.component.css']
})
export class WorldSecurityScanComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly translate = inject(TranslateService);

  activeTab: 'pattool' | 'edu' | 'scope' | 'probe' = 'pattool';

  serverLinks: SecurityAwarenessLinksDto | null = null;
  linksLoading = false;
  linksError = false;

  scopeOrganization = '';
  scopeContact = '';
  scopeDomains = '';
  scopeNotes = '';
  scopeValidUntil = '';
  scopeAuthorized = false;

  copyFeedback: 'ok' | 'fail' | null = null;

  /** État du sous-onglet « Sonde passive » : URL cible, case mandat, case contrôles actifs (OPTIONS / TRACE / robots.txt). */
  probeTargetUrl = '';
  probeAuthConfirmed = false;
  probeIncludeActive = false;
  probeRunning = false;
  probeErrorMsg: string | null = null;
  probeResult: PassiveProbeResponse | null = null;

  ngOnInit(): void {
    this.linksLoading = true;
    this.linksError = false;
    this.api
      .getSecurityAwarenessLinks()
      .pipe(
        catchError(() => {
          this.linksError = true;
          return of(null as SecurityAwarenessLinksDto | null);
        }),
        finalize(() => {
          this.linksLoading = false;
        })
      )
      .subscribe((dto) => {
        this.serverLinks = dto;
      });
  }

  setTab(tab: 'pattool' | 'edu' | 'scope' | 'probe'): void {
    this.activeTab = tab;
  }

  resetScopeForm(): void {
    this.scopeOrganization = '';
    this.scopeContact = '';
    this.scopeDomains = '';
    this.scopeNotes = '';
    this.scopeValidUntil = '';
    this.scopeAuthorized = false;
    this.copyFeedback = null;
  }

  async copyManifest(): Promise<void> {
    this.copyFeedback = null;
    if (!this.scopeAuthorized) {
      this.copyFeedback = 'fail';
      return;
    }
    const title = this.translate.instant('WORLD_SECURITY_SCAN.MANIFEST_DOC_TITLE');
    const lines = [
      `# ${title}`,
      '',
      `**${this.translate.instant('WORLD_SECURITY_SCAN.SCOPE_ORG')}:** ${this.scopeOrganization.trim() || '—'}`,
      `**${this.translate.instant('WORLD_SECURITY_SCAN.SCOPE_CONTACT')}:** ${this.scopeContact.trim() || '—'}`,
      `**${this.translate.instant('WORLD_SECURITY_SCAN.SCOPE_UNTIL')}:** ${this.scopeValidUntil.trim() || '—'}`,
      '',
      `## ${this.translate.instant('WORLD_SECURITY_SCAN.SCOPE_DOMAINS')}`,
      this.scopeDomains.trim() || '—',
      '',
      `## ${this.translate.instant('WORLD_SECURITY_SCAN.SCOPE_NOTES')}`,
      this.scopeNotes.trim() || '—',
      '',
      this.translate.instant('WORLD_SECURITY_SCAN.MANIFEST_FOOTER'),
      ''
    ];
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.copyFeedback = 'ok';
    } catch {
      this.copyFeedback = 'fail';
    }
  }

  openExternal(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  /** Appelle ApiService.passiveSiteProbe : contrôles passifs systématiques ; si probeIncludeActive, aussi OPTIONS, TRACE et GET /robots.txt côté serveur. */
  runPassiveProbe(): void {
    this.probeErrorMsg = null;
    this.probeResult = null;
    const url = this.probeTargetUrl.trim();
    if (!url || !this.probeAuthConfirmed) {
      this.probeErrorMsg = this.translate.instant('WORLD_SECURITY_SCAN.PROBE_NEED_AUTH_URL');
      return;
    }
    this.probeRunning = true;
    this.api
      .passiveSiteProbe({
        targetUrl: url,
        authorizationConfirmed: true,
        includeActiveChecks: this.probeIncludeActive
      })
      .pipe(
        catchError((err: unknown) => {
          this.probeErrorMsg = this.formatProbeHttpError(err);
          return EMPTY;
        }),
        finalize(() => {
          this.probeRunning = false;
        })
      )
      .subscribe((res) => {
        this.probeResult = res;
      });
  }

  private formatProbeHttpError(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const body = err.error;
      if (typeof body === 'string' && body.trim()) {
        return body.trim();
      }
      if (body && typeof body === 'object' && 'message' in body && typeof (body as { message: unknown }).message === 'string') {
        return String((body as { message: string }).message);
      }
    }
    return this.translate.instant('WORLD_SECURITY_SCAN.PROBE_HTTP_ERROR');
  }

  checkLabel(row: PassiveCheckRow): string {
    const key = 'WORLD_SECURITY_SCAN.PROBE_ID_' + row.id;
    const t = this.translate.instant(key);
    return t !== key ? t : row.id;
  }

  severityLabel(sev: string): string {
    const u = (sev || '').toUpperCase();
    const key = 'WORLD_SECURITY_SCAN.PROBE_SEVERITY_' + u;
    const t = this.translate.instant(key);
    return t !== key ? t : u;
  }

  severityBadgeClass(sev: string): string {
    switch ((sev || '').toUpperCase()) {
      case 'PASS':
        return 'badge rounded-pill text-bg-success';
      case 'WARN':
        return 'badge rounded-pill text-bg-warning text-dark';
      case 'FAIL':
        return 'badge rounded-pill text-bg-danger';
      case 'INFO':
        return 'badge rounded-pill text-bg-info text-dark';
      case 'ERROR':
        return 'badge rounded-pill text-bg-secondary';
      default:
        return 'badge rounded-pill text-bg-light text-dark';
    }
  }
}
