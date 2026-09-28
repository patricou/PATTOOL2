import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../environments/environment';

const APK_PATH = '/assets/downloads/pattool.apk';
const APK_INFO_PATH = '/assets/downloads/pattool-apk.json';

interface ApkInfo {
  bytes?: number;
  builtAt?: string;
}

/**
 * Download page for the Android installer. The file is published by `npm run apk`.
 */
@Component({
  selector: 'app-apk-download',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './apk-download.component.html',
  styleUrls: ['./apk-download.component.css']
})
export class ApkDownloadComponent implements OnInit {
  readonly downloadUrl = apkDownloadUrl(APK_PATH);
  available: boolean | null = null;
  bytes: number | null = null;
  builtAt: string | null = null;

  ngOnInit(): void {
    void this.loadInfo();
  }

  formatSize(bytes: number): string {
    if (bytes < 1024 * 1024) {
      return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }

  private async loadInfo(): Promise<void> {
    const infoUrl = apkDownloadUrl(APK_INFO_PATH);
    try {
      const res = await fetch(infoUrl, { cache: 'no-store' });
      if (res.status === 404) {
        this.available = false;
        return;
      }
      if (!res.ok) {
        this.available = null;
        return;
      }
      const info = (await res.json()) as ApkInfo;
      this.bytes = Number.isFinite(info.bytes) ? Number(info.bytes) : null;
      this.builtAt = info.builtAt || null;
      this.available = true;
    } catch {
      this.available = null;
    }
  }
}

/** Same-origin on the website. From the installed app, the public site. */
export function apkDownloadUrl(path: string): string {
  if (typeof location !== 'undefined') {
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('patrickdeschamps.com')) {
      return path;
    }
  }
  const origin = (environment.sharePublicOrigin || 'https://www.patrickdeschamps.com').replace(/\/$/, '');
  return `${origin}${path}`;
}
