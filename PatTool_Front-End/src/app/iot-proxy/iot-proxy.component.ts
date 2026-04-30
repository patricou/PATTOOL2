import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { take } from 'rxjs/operators';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { MembersService } from '../services/members.service';
import { Member } from '../model/member';
import { IotProxyService } from '../services/iot-proxy.service';
import { IotProxyTarget } from '../model/iot-proxy-target';

/** Merges API response into {@link IotProxyComponent#rows} (or triggers reload if id missing). */
function applySavedIotProxyRow(
    host: { rows: IotProxyTarget[]; reload(): void },
    saved: IotProxyTarget | undefined,
    asNew?: boolean
): void {
    if (!saved?.id) {
        host.reload();
        return;
    }
    const list = [...host.rows];
    const idx = list.findIndex((r) => r.id === saved.id);
    if (idx >= 0) {
        list[idx] = saved;
    } else if (asNew) {
        list.unshift(saved);
    } else {
        list.push(saved);
    }
    host.rows = list;
}

@Component({
    selector: 'app-iot-proxy',
    standalone: true,
    templateUrl: './iot-proxy.component.html',
    styleUrls: ['./iot-proxy.component.css'],
    imports: [CommonModule, FormsModule, TranslateModule, NavigationButtonsModule]
})
export class IotProxyComponent implements OnInit {

    user: Member = this.membersService.getUser();
    rows: IotProxyTarget[] = [];
    isLoading = false;
    errorMessage = '';
    showEditor = false;
    isEditMode = false;
    editing: IotProxyTarget = {};
    confirmDeleteId: string | null = null;
    /** Optional path after device base when opening in browser (e.g. index.html). */
    openPathExtra = '';

    constructor(
        private iotProxyService: IotProxyService,
        private membersService: MembersService,
        private route: ActivatedRoute,
        private router: Router
    ) {}

    ngOnInit(): void {
        this.reload();
        this.route.queryParamMap.pipe(take(1)).subscribe((q) => {
            if (q.get('new') !== '1') {
                return;
            }
            const upstream = (q.get('upstream') || '').trim();
            const desc = (q.get('desc') || '').trim();
            this.openCreatePrefill(upstream, desc);
            this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
        });
    }

    reload(): void {
        this.isLoading = true;
        this.errorMessage = '';
        this.iotProxyService.list(this.user?.id).subscribe({
            next: rows => {
                this.rows = rows || [];
                this.isLoading = false;
            },
            error: err => {
                console.error(err);
                this.errorMessage = err?.message || String(err?.statusText || '');
                this.isLoading = false;
            }
        });
    }

    openCreate(): void {
        this.openCreatePrefill('', '');
    }

    /** Opens “add proxy” with optional fields (e.g. from cameras page query params). */
    openCreatePrefill(upstreamBaseUrl: string, description: string): void {
        this.editing = {
            upstreamBaseUrl: upstreamBaseUrl || '',
            description: description || ''
        };
        this.isEditMode = false;
        this.showEditor = true;
    }

    openEdit(row: IotProxyTarget): void {
        this.editing = {
            id: row.id,
            publicSlug: row.publicSlug,
            description: row.description,
            upstreamBaseUrl: row.upstreamBaseUrl,
            upstreamUsername: row.upstreamUsername,
            upstreamPassword: '',
            hasUpstreamPassword: row.hasUpstreamPassword,
            owner: row.owner,
            creationDate: row.creationDate
        };
        this.isEditMode = true;
        this.showEditor = true;
    }

    closeEditor(): void {
        this.showEditor = false;
        this.confirmDeleteId = null;
    }

    save(): void {
        const payload = { ...this.editing };
        if (!this.editing.upstreamBaseUrl?.trim()) {
            this.errorMessage = 'upstream required';
            return;
        }
        if (this.isEditMode && this.editing.id) {
            const withoutPwd =
                !(this.editing.upstreamPassword !== undefined &&
                    String(this.editing.upstreamPassword).length > 0);
            if (withoutPwd) {
                delete payload.upstreamPassword;
            }
            this.iotProxyService.update(this.editing.id, payload, this.user?.id).subscribe({
                next: (saved) => {
                    applySavedIotProxyRow(this, saved);
                    this.closeEditor();
                },
                error: err => this.captureErr(err)
            });
            return;
        }
        delete payload.publicSlug;
        this.iotProxyService.create(payload, this.user?.id).subscribe({
            next: (saved) => {
                applySavedIotProxyRow(this, saved, true);
                this.closeEditor();
            },
            error: err => this.captureErr(err)
        });
    }

    askDelete(row: IotProxyTarget): void {
        if (!row?.id) {
            return;
        }
        this.confirmDeleteId = this.confirmDeleteId === row.id ? null : row.id;
    }

    deleteRow(row: IotProxyTarget): void {
        if (!row?.id) {
            return;
        }
        this.iotProxyService.delete(row.id, this.user?.id).subscribe({
            next: () => {
                this.confirmDeleteId = null;
                this.rows = this.rows.filter((r) => r.id !== row.id);
            },
            error: err => this.captureErr(err)
        });
    }

    openInBrowser(row: IotProxyTarget): void {
        if (!row.publicSlug) {
            return;
        }
        const path = this.openPathExtra?.trim() ? this.openPathExtra.trim() : undefined;
        this.iotProxyService.mintBrowserOpenUrl(row.publicSlug, path, this.user?.id).subscribe({
            next: res => {
                const abs = this.iotProxyService.resolveBackendAbsoluteUrl(res.relativeUrlWithQuery);
                window.open(abs, '_blank', 'noopener,noreferrer');
            },
            error: err => this.captureErr(err)
        });
    }

    private captureErr(err: unknown): void {
        console.error(err);
        let msg = 'Error';
        if (err && typeof err === 'object' && 'error' in err) {
            const e = (err as { error?: Record<string, string> }).error;
            if (e && typeof e['error'] === 'string') {
                msg = e['error'];
            }
        } else if (err && typeof err === 'object' && 'statusText' in err) {
            msg = String((err as { statusText?: string }).statusText);
        }
        this.errorMessage = msg;
    }

    formatDate(value: unknown): string {
        if (value === null || value === undefined || value === '') {
            return '—';
        }
        try {
            return new Date(String(value)).toLocaleString();
        } catch {
            return String(value);
        }
    }
}
