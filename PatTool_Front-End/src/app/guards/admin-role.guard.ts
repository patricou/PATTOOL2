import { Injectable } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';
import { KeycloakService } from '../keycloak/keycloak.service';

/** Blocks navigation unless the user has the Keycloak Admin role. */
@Injectable({ providedIn: 'root' })
export class AdminRoleGuard implements CanActivate {
  constructor(
    private readonly keycloak: KeycloakService,
    private readonly router: Router
  ) {}

  canActivate(): boolean | UrlTree {
    if (this.keycloak.hasAdminRole()) {
      return true;
    }
    return this.router.parseUrl('/home');
  }
}
