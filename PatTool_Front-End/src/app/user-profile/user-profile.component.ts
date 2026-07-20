import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { Member } from '../model/member';
import { KeycloakService } from '../keycloak/keycloak.service';
import { MembersService } from '../services/members.service';
import { ApiService, UserAppParameter } from '../services/api.service';

@Component({
  selector: 'app-user-profile',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './user-profile.component.html',
  styleUrls: ['./user-profile.component.css']
})
export class UserProfileComponent implements OnInit, OnDestroy {
  user: Member = new Member('', '', '', '', '', [], '');
  roles: string[] = [];
  parameters: UserAppParameter[] = [];
  isLoadingUser = true;
  isLoadingParams = true;
  paramsError = '';
  expandedKey: string | null = null;

  private subs: Subscription[] = [];

  constructor(
    private keycloak: KeycloakService,
    private members: MembersService,
    private api: ApiService
  ) {}

  ngOnInit(): void {
    this.user = this.keycloak.getUserAsMember();
    this.roles = this.filterRoles(this.user.roles || this.keycloak.getAllRoles() || []);
    this.members.setUser(this.user);
    this.isLoadingUser = true;
    this.subs.push(
      this.members.getUserId({ skipGeolocation: true }).subscribe({
        next: (m) => {
          this.user = m;
          this.roles = this.filterRoles(m.roles || []);
          this.isLoadingUser = false;
        },
        error: () => {
          this.isLoadingUser = false;
        }
      })
    );

    this.isLoadingParams = true;
    this.paramsError = '';
    this.subs.push(
      this.api.getUserAppParameters().subscribe({
        next: (rows) => {
          this.parameters = rows || [];
          this.isLoadingParams = false;
        },
        error: () => {
          this.paramsError = 'USERINFO.PARAMS_ERROR';
          this.isLoadingParams = false;
        }
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  sendEmail(email: string): void {
    if (!email) {
      return;
    }
    window.location.href = `mailto:${email}`;
  }

  getRoleBadgeClass(role: string): string {
    if (!role) {
      return 'bg-primary';
    }
    const roleLower = role.toLowerCase().trim();
    if (roleLower === 'admin' || roleLower === 'administrator') {
      return 'bg-danger';
    }
    if (roleLower === 'user' || roleLower === 'utilisateur') {
      return 'bg-success';
    }
    return 'bg-primary';
  }

  toggleExpand(key: string): void {
    this.expandedKey = this.expandedKey === key ? null : key;
  }

  formatValue(p: UserAppParameter): string {
    const raw = p.paramValue ?? '';
    if ((p.valueType || '').toUpperCase() === 'JSON') {
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        return raw;
      }
    }
    return raw;
  }

  isLongValue(p: UserAppParameter): boolean {
    return (p.paramValue || '').length > 120 || (p.valueType || '').toUpperCase() === 'JSON';
  }

  closeTab(): void {
    try {
      window.close();
    } catch {
      /* ignore */
    }
    // Fallback when the tab was not opened by script (browser ignores close).
    setTimeout(() => {
      try {
        if (!window.closed) {
          window.location.hash = '#/photos';
        }
      } catch {
        window.location.hash = '#/photos';
      }
    }, 150);
  }

  private filterRoles(roles: string[]): string[] {
    return (roles || []).filter(
      (r) => r && r !== 'uma_protection' && r !== 'uma_authorization'
    );
  }
}
