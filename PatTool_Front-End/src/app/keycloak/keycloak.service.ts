import { Injectable } from '@angular/core';

import { environment } from '../../environments/environment';
import { Member } from '../model/member';
import { isBrowserOffline } from '../shared/browser-offline.util';

declare var Keycloak: any;

interface PersistedKcSession {
  token: string;
  refreshToken: string;
  idToken?: string;
  timeSkew?: number;
}

@Injectable({ providedIn: 'root' })
export class KeycloakService {
  static auth: any = {};
  private static tokenCache: { token: string; atMs: number } = { token: '', atMs: 0 };
  private static readonly SESSION_STORAGE_KEY = 'pattool.kc.session';

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

    const stored = KeycloakService.readPersistedSession();
    const offline = isBrowserOffline();
    const initOptions: any = {
      checkLoginIframe: false  // Disable login status iframe to prevent stuck loading state
    };
    if (stored?.token && stored?.refreshToken) {
      initOptions.token = stored.token;
      initOptions.refreshToken = stored.refreshToken;
      if (stored.idToken) {
        initOptions.idToken = stored.idToken;
      }
      if (typeof stored.timeSkew === 'number') {
        initOptions.timeSkew = stored.timeSkew;
      }
    }
    // Never send the tab to Keycloak when we already have a session:
    // a failed refresh + login() is what Chrome turns into "Vous êtes hors connexion".
    if (!offline && !(stored?.token && stored?.refreshToken)) {
      initOptions.onLoad = 'login-required';
    }

    return new Promise((resolve, reject) => {
      const finish = (loggedIn: boolean) => {
        KeycloakService.auth.loggedIn = loggedIn;
        KeycloakService.auth.authz = keycloakAuth;
        if (keycloakAuth.token) {
          KeycloakService.persistSession(keycloakAuth);
          KeycloakService.auth.logoutUrl =
            keycloakAuth.authServerUrl +
            '/realms/pat-realm/protocol/openid-connect/logout?redirect_uri='
            + document.baseURI;
        }
        resolve(document.baseURI);
      };

      keycloakAuth.init(initOptions)
        .success(() => {
          finish(!!keycloakAuth.token);
        })
        .error(() => {
          if (keycloakAuth.token) {
            console.warn('[KEYCLOAK SERVICE] init token refresh failed — keeping stored session');
            finish(true);
            return;
          }
          if (offline) {
            console.warn('[KEYCLOAK SERVICE] init failed offline — bootstrap without Keycloak redirect');
            finish(false);
            return;
          }
          reject();
        });
    });
  }

  logout() {
    console.log('*** LOGOUT');
    // Immediately clear local session state
    KeycloakService.auth.loggedIn = false;
    KeycloakService.tokenCache = { token: '', atMs: 0 };
    KeycloakService.clearPersistedSession();
    
    // Clear Keycloak session and redirect to login page immediately
    if (KeycloakService.auth.authz) {
      try {
        // Clear the token immediately
        if (KeycloakService.auth.authz.token) {
          KeycloakService.auth.authz.token = null;
        }
        
        // Get base URL for redirect after login
        const baseUrl = window.location.origin + window.location.pathname;
        
        // Call Keycloak logout to clear server session, then redirect to base URL
        // The app will reload and trigger login-required flow, redirecting to login
        KeycloakService.auth.authz.logout({
          redirectUri: baseUrl
        });
      } catch (error) {
        console.error('Error during logout:', error);
        // Fallback: redirect to login page directly
        this.redirectToLogin();
      }
    } else {
      // If Keycloak not initialized, just redirect to login
      this.redirectToLogin();
    }
  }

  getToken(options?: { redirectOnFailure?: boolean }): Promise<string> {
    const redirectOnFailure = options?.redirectOnFailure !== false;
    return new Promise<string>((resolve, reject) => {
      // Check if Keycloak is initialized
      if (!KeycloakService.auth.authz) {
        reject('Keycloak not initialized');
        return;
      }
      
      if (KeycloakService.auth.authz.token) {
        const authz: any = KeycloakService.auth.authz;
        const token: string = <string>authz.token;

        // Offline: never call Keycloak (refresh would fail and login() would wipe GPS).
        if (isBrowserOffline()) {
          KeycloakService.tokenCache = { token, atMs: Date.now() };
          resolve(token);
          return;
        }

        // Fast path: if token is valid for > 60s, don't call updateToken() (avoids slow network refresh)
        try {
          const exp: number | undefined = authz?.tokenParsed?.exp;
          const nowSec = Math.floor(Date.now() / 1000);
          const ttlSec = exp ? (exp - nowSec) : 0;

          if (ttlSec > 60) {
            KeycloakService.tokenCache = { token, atMs: Date.now() };
            KeycloakService.persistSession(authz);
            resolve(token);
            return;
          }
        } catch (e) {
          // Ignore parsing errors and fall back to refresh path
        }

        authz
          .updateToken(5)
          .success(() => {
            const refreshedToken: string = <string>KeycloakService.auth.authz.token;
            KeycloakService.tokenCache = { token: refreshedToken, atMs: Date.now() };
            KeycloakService.persistSession(KeycloakService.auth.authz);
            resolve(refreshedToken);
          })
          .error(() => {
            const stale: string = <string>(KeycloakService.auth.authz?.token || '');
            if (stale) {
              console.warn('[KEYCLOAK SERVICE] Token refresh failed — keeping existing token (no login redirect)');
              KeycloakService.tokenCache = { token: stale, atMs: Date.now() };
              resolve(stale);
              return;
            }
            console.warn('[KEYCLOAK SERVICE] ⚠️ Failed to refresh token - session expired, redirecting to login');
            console.trace('[KEYCLOAK SERVICE] Stack trace for token refresh failure:');
            const currentPath = window.location.pathname;
            if (redirectOnFailure && !isBrowserOffline() && !currentPath.includes('login') && !currentPath.includes('error')) {
              this.redirectToLogin();
            }
            reject('Token refresh failed');
          });
      } else {
        console.log('No token available - redirecting to login');
        if (redirectOnFailure && !isBrowserOffline()) {
          this.redirectToLogin();
        }
        reject('Not logged in');
      }
    });
  }

  /**
   * Redirects to Keycloak login page when session has expired
   */
  redirectToLogin(): void {
    if (isBrowserOffline()) {
      console.warn('[KEYCLOAK SERVICE] skip login redirect while offline (keeps current page, e.g. GPS)');
      return;
    }
    console.warn('[KEYCLOAK SERVICE] ⚠️ redirectToLogin() called - Current URL:', window.location.href);
    console.trace('[KEYCLOAK SERVICE] Stack trace for redirectToLogin():');
    
    try {
      if (KeycloakService.auth.authz && typeof KeycloakService.auth.authz.login === 'function') {
        // Use Keycloak's login method to redirect to login page
        console.warn('[KEYCLOAK SERVICE] Using Keycloak login() method to redirect');
        KeycloakService.auth.authz.login({
          redirectUri: window.location.href
        });
      } else {
        // If Keycloak is not initialized or login method not available, construct login URL manually
        console.warn('[KEYCLOAK SERVICE] Keycloak login() not available, constructing URL manually');
        const loginUrl = this.getLoginUrl();
        if (loginUrl) {
          console.warn('[KEYCLOAK SERVICE] Redirecting to:', loginUrl);
          window.location.href = loginUrl;
        } else {
          console.error('[KEYCLOAK SERVICE] Unable to construct login URL - Keycloak not properly initialized');
        }
      }
    } catch (error) {
      console.error('[KEYCLOAK SERVICE] Error redirecting to login:', error);
      // Fallback: try to construct URL manually
      const loginUrl = this.getLoginUrl();
      if (loginUrl) {
        console.warn('[KEYCLOAK SERVICE] Fallback redirect to:', loginUrl);
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

  /**
   * Access-token expiry as Unix seconds, or null when unavailable.
   */
  getAccessTokenExpiresAt(): number | null {
    const exp = KeycloakService.auth.authz?.tokenParsed?.exp;
    return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp : null;
  }

  /**
   * Session expiry (refresh token when present, otherwise access token) as Unix seconds.
   */
  getSessionExpiresAt(): number | null {
    const refreshExp = KeycloakService.auth.authz?.refreshTokenParsed?.exp;
    if (typeof refreshExp === 'number' && Number.isFinite(refreshExp) && refreshExp > 0) {
      return refreshExp;
    }
    return this.getAccessTokenExpiresAt();
  }

  getAuth(): any {
    return KeycloakService.auth.authz;
  }

  /**
   * Utilisable par l’UI (assistant, etc.) : certains adapters n’expose pas `authenticated`,
   * alors que `loggedIn` + token sont corrects après le flux login-required.
   */
  isLoggedIn(): boolean {
    if (!KeycloakService.auth?.loggedIn) {
      return false;
    }
    const authz: any = KeycloakService.auth.authz;
    if (!authz) {
      return false;
    }
    if (typeof authz.authenticated === 'boolean') {
      return authz.authenticated;
    }
    return !!(typeof authz.token === 'string' && authz.token.length > 0);
  }

  getUserAsMember(): Member {
    let user = KeycloakService.auth.authz;
    const parsed = user?.tokenParsed;
    if (!parsed) {
      return new Member('', '', '', '', '', [], '');
    }
    // id is managed by mongodb
    let member: Member = new Member("",
      parsed.email,
      parsed.given_name,
      parsed.family_name,
      parsed.preferred_username,
      parsed.realm_access?.roles || [],
      user.subject
    );
    return member;

  }

  private static readPersistedSession(): PersistedKcSession | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    try {
      const raw = localStorage.getItem(KeycloakService.SESSION_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as PersistedKcSession;
      if (!parsed?.token || !parsed?.refreshToken) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private static persistSession(authz: any): void {
    if (typeof localStorage === 'undefined' || !authz?.token || !authz?.refreshToken) {
      return;
    }
    try {
      const payload: PersistedKcSession = {
        token: authz.token,
        refreshToken: authz.refreshToken
      };
      if (authz.idToken) {
        payload.idToken = authz.idToken;
      }
      if (typeof authz.timeSkew === 'number') {
        payload.timeSkew = authz.timeSkew;
      }
      localStorage.setItem(KeycloakService.SESSION_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Quota / private mode: GPS can still run from in-memory tokens.
    }
  }

  private static clearPersistedSession(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.removeItem(KeycloakService.SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
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
      const clientIdsToTry = new Set<string>();
      if (typeof authz.clientId === 'string' && authz.clientId.trim().length > 0) {
        clientIdsToTry.add(authz.clientId.trim());
      }
      clientIdsToTry.add('tutorial-frontend');
      for (const cid of clientIdsToTry) {
        if (authz.hasResourceRole(role, cid)) {
          return true;
        }
      }
      // Try default client (library-dependent)
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

      // Tous les clients du token — le rôle Admin peut être défini hors tutorial-frontend
      if (tokenParsed.resource_access && typeof tokenParsed.resource_access === 'object') {
        const ra = tokenParsed.resource_access as Record<string, { roles?: unknown }>;
        const roleLc = role.toLowerCase();
        for (const key of Object.keys(ra)) {
          const cr = ra[key]?.roles;
          if (!Array.isArray(cr)) {
            continue;
          }
          for (const clientRole of cr) {
            if (
              typeof clientRole === 'string' &&
              clientRole.length > 0 &&
              clientRole.toLowerCase() === roleLc
            ) {
              return true;
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

  /** JWT Keycloak `sub` (identifiant opaque). */
  getJwtSubject(): string | null {
    const s = KeycloakService.auth.authz?.subject;
    return typeof s === 'string' && s.trim().length > 0 ? s.trim() : null;
  }

  /** Claim `preferred_username` du token courant. */
  getPreferredUsername(): string | null {
    const u = KeycloakService.auth.authz?.tokenParsed?.preferred_username;
    return typeof u === 'string' && u.trim().length > 0 ? u.trim() : null;
  }

  /**
   * Libellé utilisateur lisible : login Keycloak, sinon partie locale de l’email du token.
   */
  getUsernameForDisplay(): string | null {
    const pref = this.getPreferredUsername();
    if (pref) {
      return pref;
    }
    const email = KeycloakService.auth.authz?.tokenParsed?.email;
    if (typeof email === 'string' && email.includes('@')) {
      const local = email.split('@')[0].trim();
      return local.length > 0 ? local : null;
    }
    return null;
  }

  /**
   * True if {@code stored} is this session's JWT {@code sub} or login (surnom /
   * {@code preferred_username}). Used so rows persisted under either Keycloak id
   * or username still count as "me".
   */
  isCurrentUserIdentity(stored: string | null | undefined): boolean {
    const v = (stored ?? '').trim();
    if (!v) {
      return false;
    }
    const aliases = [
      this.getJwtSubject(),
      this.getPreferredUsername(),
      this.getUsernameForDisplay()
    ];
    const lower = v.toLowerCase();
    for (const a of aliases) {
      if (a && a.trim().toLowerCase() === lower) {
        return true;
      }
    }
    return false;
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