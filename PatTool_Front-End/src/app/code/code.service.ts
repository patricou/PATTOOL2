import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, forkJoin, from, map, switchMap } from 'rxjs';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { MembersService } from '../services/members.service';
import { AssistantProviderSlug } from '../services/assistant.service';

export interface CodeProjectFile {
  path: string;
  content?: string | null;
  language?: string | null;
}

export interface CodeChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CodeProject {
  id?: string;
  ownerMemberId?: string;
  ownerDisplayName?: string | null;
  name: string;
  description?: string | null;
  language?: string | null;
  repoUrl?: string | null;
  files?: CodeProjectFile[];
  chatTurns?: CodeChatTurn[];
  provider?: string | null;
  model?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CodeRepoFile {
  path: string;
  language?: string | null;
  content: string;
  size: number;
}

export interface CodeRepoAnalyzeResponse {
  host?: string;
  owner?: string;
  name?: string;
  defaultBranch?: string;
  description?: string | null;
  htmlUrl?: string | null;
  truncated?: boolean;
  message?: string | null;
  files?: CodeRepoFile[];
  error?: string;
}

export interface CodeRepoSearchHit {
  host?: string;
  owner?: string;
  name?: string;
  fullName?: string;
  description?: string | null;
  language?: string | null;
  htmlUrl?: string | null;
  defaultBranch?: string | null;
  stars?: number;
}

export interface CodeRepoSearchResponse {
  total?: number;
  items?: CodeRepoSearchHit[];
  interpretedQuery?: string | null;
  summary?: string | null;
  naturalLanguage?: boolean;
}

export interface CodeRepoTreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | string;
  size?: number;
}

export interface CodeRepoTreeResponse {
  host?: string;
  owner?: string;
  name?: string;
  htmlUrl?: string | null;
  defaultBranch?: string | null;
  path?: string;
  entries?: CodeRepoTreeEntry[];
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class CodeWorkbenchService {
  private readonly baseUrl = `${environment.API_URL}code-workbench`;

  constructor(
    private http: HttpClient,
    private keycloak: KeycloakService,
    private membersService: MembersService
  ) {}

  private withUserHeaders(): Observable<HttpHeaders> {
    return forkJoin({
      member: this.membersService.getUserId({ skipGeolocation: true }),
      token: from(this.keycloak.getToken())
    }).pipe(
      map(({ member, token }) => {
        let h = new HttpHeaders({
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'user-id': member.id || ''
        });
        if (token) {
          h = h.set('Authorization', 'Bearer ' + token);
        }
        return h;
      })
    );
  }

  list(): Observable<CodeProject[]> {
    return this.withUserHeaders().pipe(
      switchMap((headers) => this.http.get<CodeProject[]>(`${this.baseUrl}/projects`, { headers }))
    );
  }

  getOne(id: string): Observable<CodeProject> {
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.get<CodeProject>(`${this.baseUrl}/projects/${encodeURIComponent(id)}`, { headers })
      )
    );
  }

  create(body: CodeProject): Observable<CodeProject> {
    return this.withUserHeaders().pipe(
      switchMap((headers) => this.http.post<CodeProject>(`${this.baseUrl}/projects`, body, { headers }))
    );
  }

  update(id: string, body: CodeProject): Observable<CodeProject> {
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.put<CodeProject>(`${this.baseUrl}/projects/${encodeURIComponent(id)}`, body, { headers })
      )
    );
  }

  delete(id: string): Observable<void> {
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.delete(`${this.baseUrl}/projects/${encodeURIComponent(id)}`, {
          headers,
          observe: 'response',
          responseType: 'text'
        })
      ),
      map((res) => {
        if (res.status === 204 || res.status === 200) {
          return;
        }
        throw new Error(`delete failed: HTTP ${res.status}`);
      })
    );
  }

  analyzeRepo(url: string, branch?: string): Observable<CodeRepoAnalyzeResponse> {
    const body: { url: string; branch?: string } = { url: url.trim() };
    const b = (branch || '').trim();
    if (b) {
      body.branch = b;
    }
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.post<CodeRepoAnalyzeResponse>(`${this.baseUrl}/repo/analyze`, body, { headers })
      )
    );
  }

  searchRepos(
    query: string,
    host?: string,
    page?: number,
    opts?: { naturalLanguage?: boolean; provider?: string | null; model?: string | null }
  ): Observable<CodeRepoSearchResponse> {
    const body: {
      query: string;
      host?: string;
      page?: number;
      naturalLanguage?: boolean;
      provider?: string;
      model?: string;
    } = { query: query.trim() };
    if (host && host.trim()) {
      body.host = host.trim();
    }
    if (page && page > 0) {
      body.page = page;
    }
    if (opts?.naturalLanguage) {
      body.naturalLanguage = true;
    }
    const provider = (opts?.provider || '').trim();
    const model = (opts?.model || '').trim();
    if (provider) {
      body.provider = provider;
    }
    if (model) {
      body.model = model;
    }
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.post<CodeRepoSearchResponse>(`${this.baseUrl}/repo/search`, body, { headers })
      )
    );
  }

  repoTree(url: string, branch?: string, path?: string): Observable<CodeRepoTreeResponse> {
    const body: { url: string; branch?: string; path?: string } = { url: url.trim() };
    const b = (branch || '').trim();
    const p = (path || '').trim();
    if (b) {
      body.branch = b;
    }
    if (p) {
      body.path = p;
    }
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.post<CodeRepoTreeResponse>(`${this.baseUrl}/repo/tree`, body, { headers })
      )
    );
  }

  repoFile(url: string, path: string, branch?: string): Observable<CodeRepoFile> {
    const body: { url: string; path: string; branch?: string } = {
      url: url.trim(),
      path: path.trim()
    };
    const b = (branch || '').trim();
    if (b) {
      body.branch = b;
    }
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.post<CodeRepoFile>(`${this.baseUrl}/repo/file`, body, { headers })
      )
    );
  }
}

export function languageFromPath(path: string): string {
  const lower = (path || '').toLowerCase();
  const file = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower;
  if (file.startsWith('readme')) {
    return 'markdown';
  }
  const dot = file.lastIndexOf('.');
  const ext = dot >= 0 ? file.slice(dot) : '';
  const map: Record<string, string> = {
    '.java': 'java',
    '.kt': 'kotlin',
    '.py': 'python',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.php': 'php',
    '.cs': 'csharp',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.sql': 'sql',
    '.html': 'html',
    '.css': 'css',
    '.json': 'json',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.xml': 'xml',
    '.sh': 'shell',
    '.vue': 'vue',
    '.md': 'markdown'
  };
  return map[ext] || '';
}

export const CODE_PROVIDERS: { slug: AssistantProviderSlug; labelKey: string }[] = [
  { slug: 'anthropic', labelKey: 'ASSISTANT.PROVIDER_ANTHROPIC' },
  { slug: 'gemini', labelKey: 'ASSISTANT.PROVIDER_GEMINI' },
  { slug: 'mistral', labelKey: 'ASSISTANT.PROVIDER_MISTRAL' },
  { slug: 'openai', labelKey: 'ASSISTANT.PROVIDER_OPENAI' },
  { slug: 'spacexai', labelKey: 'ASSISTANT.PROVIDER_SPACEXAI' }
];
