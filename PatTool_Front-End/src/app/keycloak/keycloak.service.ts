import { Injectable } from '@angular/core';

import { environment } from '../../environments/environment';
import { Member } from '../model/member';

declare var Keycloak: any;

@Injectable()
export class KeycloakService {
  static auth: any = {};

  static init(): Promise<any> {
    const keycloakAuth: any = new Keycloak({
      "url": environment.keykloakBaseUrl,
      "realm": 'pat-realm',
      "clientId": 'tutorial-frontend',
      "auth-server-url": "/auth",
      "ssl-required": "true",
      "resource": "tutorial-frontend",
      "public-client": true,
      "use-resource-role-mappings": true
    });

    KeycloakService.auth.loggedIn = false;

    return new Promise((resolve, reject) => {
      keycloakAuth.init({ 
        onLoad: 'login-required',
        checkLoginIframe: false  // Disable login status iframe to prevent stuck loading state
      })
        .success(() => {
          KeycloakService.auth.loggedIn = true;
          KeycloakService.auth.authz = keycloakAuth;
          // console.log ("|------------> document.baseURI :" + document.baseURI );
          //console.log ("|----------->  keycloakAuth :" + JSON.stringify(keycloakAuth) );
          KeycloakService.auth.logoutUrl =
            keycloakAuth.authServerUrl +
            '/realms/pat-realm/protocol/openid-connect/logout?redirect_uri='
            + document.baseURI;
          resolve(document.baseURI);
        })
        .error(() => {
          reject();
        });
    });
  }

  logout() {
    console.log('*** LOGOUT');
    KeycloakService.auth.authz.logout();
    KeycloakService.auth.loggedIn = false;
    window.location.href = KeycloakService.auth.logoutUrl;
  }

  getToken(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // Check if Keycloak is initialized
      if (!KeycloakService.auth.authz) {
        reject('Keycloak not initialized');
        return;
      }
      
      if (KeycloakService.auth.authz.token) {
        KeycloakService.auth.authz
          .updateToken(5)
          .success(() => {
            resolve(<string>KeycloakService.auth.authz.token);
          })
          .error(() => {
            console.log('Failed to refresh token - session expired, redirecting to login');
            // Session expired - redirect to Keycloak login
            this.redirectToLogin();
            reject('Token refresh failed');
          });
      } else {
        // No token available - redirect to login
        console.log('No token available - redirecting to login');
        this.redirectToLogin();
        reject('Not logged in');
      }
    });
  }

  /**
   * Redirects to Keycloak login page when session has expired
   */
  redirectToLogin(): void {
    try {
      if (KeycloakService.auth.authz && typeof KeycloakService.auth.authz.login === 'function') {
        // Use Keycloak's login method to redirect to login page
        KeycloakService.auth.authz.login({
          redirectUri: window.location.href
        });
      } else {
        // If Keycloak is not initialized or login method not available, construct login URL manually
        const loginUrl = this.getLoginUrl();
        if (loginUrl) {
          window.location.href = loginUrl;
        } else {
          console.error('Unable to construct login URL - Keycloak not properly initialized');
        }
      }
    } catch (error) {
      console.error('Error redirecting to login:', error);
      // Fallback: try to construct URL manually
      const loginUrl = this.getLoginUrl();
      if (loginUrl) {
        window.location.href = loginUrl;
      }
    }
  }

  /**
   * Constructs the Keycloak login URL
   */
  private getLoginUrl(): string {
    // Use values from Keycloak instance if available, otherwise use defaults
    const authz = KeycloakService.auth.authz;
    const authServerUrl = (authz && authz.authServerUrl) ? authz.authServerUrl : environment.keykloakBaseUrl;
    const realm = (authz && authz.realm) ? authz.realm : 'pat-realm';
    const clientId = (authz && authz.clientId) ? authz.clientId : 'tutorial-frontend';
    const redirectUri = encodeURIComponent(window.location.href);
    
    // Remove trailing slash from authServerUrl if present
    const baseUrl = authServerUrl.endsWith('/') ? authServerUrl.slice(0, -1) : authServerUrl;
    
    return `${baseUrl}/realms/${realm}/protocol/openid-connect/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=openid`;
  }

  getTokenSync(): string {
    if (KeycloakService.auth.authz && KeycloakService.auth.authz.token) {
      return KeycloakService.auth.authz.token;
    }
    return '';
  }

  getAuth(): any {
    return KeycloakService.auth.authz;
  }

  getUserAsMember(): Member {
    let user = KeycloakService.auth.authz;
    // id is managed by mongodb
    let member: Member = new Member("",
      user.tokenParsed.email,
      user.tokenParsed.given_name,
      user.tokenParsed.family_name,
      user.tokenParsed.preferred_username,
      user.tokenParsed.realm_access.roles,
      user.subject
    );
    return member;

  }

  /**
   * Check if the current user has a specific role
   * @param role The role name to check (without ROLE_ prefix)
   * @returns true if user has the role, false otherwise
   */
  hasRole(role: string): boolean {
    if (!KeycloakService.auth.authz) {
      console.warn('Keycloak not initialized in hasRole check');
      return false;
    }
    
    const authz = KeycloakService.auth.authz;
    
    // Check realm roles using hasRealmRole method
    if (authz.hasRealmRole && typeof authz.hasRealmRole === 'function') {
      if (authz.hasRealmRole(role)) {
        return true;
      }
    }
    
    // Check resource roles (client roles) using hasResourceRole method
    if (authz.hasResourceRole && typeof authz.hasResourceRole === 'function') {
      // Try with explicit clientId
      if (authz.hasResourceRole(role, 'tutorial-frontend')) {
        return true;
      }
      // Try without clientId (uses default)
      if (authz.hasResourceRole(role)) {
        return true;
      }
    }
    
    // Fallback: Check token directly if methods don't work
    if (authz.tokenParsed) {
      const tokenParsed = authz.tokenParsed;
      
      // Check realm_access.roles (case-insensitive comparison)
      if (tokenParsed.realm_access && tokenParsed.realm_access.roles) {
        const realmRoles = tokenParsed.realm_access.roles;
        if (Array.isArray(realmRoles)) {
          for (const realmRole of realmRoles) {
            if (realmRole && realmRole.toLowerCase() === role.toLowerCase()) {
              return true;
            }
          }
        }
      }
      
      // Check resource_access.{clientId}.roles (case-insensitive comparison)
      if (tokenParsed.resource_access) {
        const clientId = authz.clientId || 'tutorial-frontend';
        const clientAccess = tokenParsed.resource_access[clientId];
        if (clientAccess && clientAccess.roles) {
          const clientRoles = clientAccess.roles;
          if (Array.isArray(clientRoles)) {
            for (const clientRole of clientRoles) {
              if (clientRole && clientRole.toLowerCase() === role.toLowerCase()) {
                return true;
              }
            }
          }
        }
      }
    }
    
    return false;
  }

  /**
   * Check if the current user has Iot role
   * @returns true if user has Iot role, false otherwise
   */
  hasIotRole(): boolean {
    // Check both "Iot" and "iot" (case-insensitive)
    return this.hasRole('Iot') || this.hasRole('iot');
  }

  /**
   * Check if the current user has Admin role
   * @returns true if user has Admin role, false otherwise
   */
  hasAdminRole(): boolean {
    // Check both "Admin" and "admin" (case-insensitive)
    return this.hasRole('Admin') || this.hasRole('admin');
  }

  /**
   * Check if the current user has FileSystem role
   * @returns true if user has FileSystem role, false otherwise
   */
  hasFileSystemRole(): boolean {
    // Check both "FileSystem" and "filesystem" (case-insensitive)
    return this.hasRole('FileSystem') || this.hasRole('filesystem');
  }

  /**
   * Get all roles for the current user (for debugging)
   * @returns Array of role names
   */
  getAllRoles(): string[] {
    const roles: string[] = [];
    
    if (!KeycloakService.auth.authz) {
      console.warn('Keycloak not initialized in getAllRoles');
      return roles;
    }
    
    const authz = KeycloakService.auth.authz;
    
    // Get realm roles from token
    if (authz.tokenParsed && authz.tokenParsed.realm_access && authz.tokenParsed.realm_access.roles) {
      const realmRoles = authz.tokenParsed.realm_access.roles;
      if (Array.isArray(realmRoles)) {
        roles.push(...realmRoles);
      }
    }
    
    // Get resource roles from token
    if (authz.tokenParsed && authz.tokenParsed.resource_access) {
      const clientId = authz.clientId || 'tutorial-frontend';
      const clientAccess = authz.tokenParsed.resource_access[clientId];
      if (clientAccess && clientAccess.roles) {
        const clientRoles = clientAccess.roles;
        if (Array.isArray(clientRoles)) {
          roles.push(...clientRoles);
        }
      }
    }
    
    return roles;
  }
}