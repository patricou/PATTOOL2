import { Injectable } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';
import { KeycloakService } from '../keycloak/keycloak.service';

/**
 * Blocks navigation to Maison (IoT) UI routes unless the user has the Keycloak Iot role.
 */
@Injectable({ providedIn: 'root' })
export class IotRoleGuard implements CanActivate {
  constructor(
    private readonly keycloak: KeycloakService,
    private readonly router: Router
  ) {}

  canActivate(): boolean | UrlTree {
    if (this.keycloak.hasIotRole()) {
      return true;
    }
    return this.router.parseUrl('/home');
  }
}
