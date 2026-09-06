import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, Subscription, of } from 'rxjs';
import { catchError, debounceTime } from 'rxjs/operators';
import {
  AssistantChatTurn,
  AssistantProviderSlug,
  AssistantService,
  isAssistantProviderSlug
} from '../services/assistant.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import {
  ASSISTANT_ANTHROPIC_MODEL_PRESETS,
  ASSISTANT_GEMINI_MODEL_PRESETS,
  ASSISTANT_MISTRAL_MODEL_PRESETS,
  ASSISTANT_OPENAI_MODEL_PRESETS,
  ASSISTANT_SPACEXAI_MODEL_PRESETS
} from '../shared/assistant-drawer/assistant-model-presets';
import {
  CODE_PROVIDERS,
  CodeChatTurn,
  CodeProject,
  CodeProjectFile,
  CodeRepoAnalyzeResponse,
  CodeRepoFile,
  CodeRepoSearchHit,
  CodeRepoTreeEntry,
  CodeRepoTreeResponse,
  CodeWorkbenchService,
  languageFromPath
} from './code.service';
import { highlightMarkdown, highlightSource } from './code-highlight';

@Component({
  selector: 'app-code',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './code.component.html',
  styleUrls: ['./code.component.css']
})
export class CodeComponent implements OnInit, OnDestroy {
  readonly providers = CODE_PROVIDERS;
  readonly languages = ['java', 'typescript', 'javascript', 'python', 'go', 'csharp', 'rust', 'php', 'sql', 'other'];

  projects: CodeProject[] = [];
  current: CodeProject | null = null;
  selectedFileIndex = 0;
  draftPrompt = '';
  repoUrl = '';
  repoBranch = '';
  repoPreview: CodeRepoAnalyzeResponse | null = null;
  repoSearchQuery = '';
  repoSearchHost: 'all' | 'github' | 'gitlab' = 'all';
  repoSearchNatural = true;
  repoHits: CodeRepoSearchHit[] = [];
  repoSearchInterpreted = '';
  repoSearchSummary = '';
  searchingRepos = false;
  repoTree: CodeRepoTreeResponse | null = null;
  repoTreePath = '';
  loadingTree = false;
  loadingRepoFile = false;
  repoOpenFile: CodeRepoFile | null = null;
  readonly repoExamples = [
    'PATTOOL2',
    'patricou/PATTOOL2',
    'une lib python pour parser du HTML',
    'facebook/react'
  ];
  private treeReq = 0;
  private treeCacheRepo = '';
  private readonly treeCache = new Map<string, CodeRepoTreeResponse>();
  private repoFlat: CodeRepoTreeEntry[] | null = null;
  private indexReq = 0;
  models: string[] = [];
  customModel = '';
  sending = false;
  saving = false;
  loadingList = false;
  loadingProject = false;
  fetchingRepo = false;
  dirty = false;
  errorKey: string | null = null;
  statusKey: string | null = null;
  applyCandidates: { path: string; content: string }[] = [];
  editorCssFs = false;
  repoCssFs = false;

  private readonly persist$ = new Subject<void>();
  private persistSub?: Subscription;
  private chatScroll?: ElementRef<HTMLDivElement>;

  @ViewChild('editorStage') editorStage?: ElementRef<HTMLElement>;
  @ViewChild('editorPre') editorPre?: ElementRef<HTMLPreElement>;
  @ViewChild('repoPreviewStage') repoPreviewStage?: ElementRef<HTMLElement>;

  @ViewChild('chatScroll') set chatScrollRef(el: ElementRef<HTMLDivElement> | undefined) {
    this.chatScroll = el;
    this.scrollChat();
  }

  constructor(
    private readonly codeApi: CodeWorkbenchService,
    private readonly assistant: AssistantService,
    private readonly keycloak: KeycloakService,
    private readonly translate: TranslateService,
    private readonly sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    this.persistSub = this.persist$.pipe(debounceTime(1200)).subscribe(() => this.saveCurrent(true));
    this.bootstrapRouting();
    this.reloadList();
  }

  ngOnDestroy(): void {
    this.persistSub?.unsubscribe();
    void this.exitOwnedFullscreen();
  }

  get editorFullscreen(): boolean {
    return this.editorCssFs || this.isFullscreenHost(this.editorStage?.nativeElement);
  }

  get repoFullscreen(): boolean {
    return this.repoCssFs || this.isFullscreenHost(this.repoPreviewStage?.nativeElement);
  }

  highlightedEditorHtml(): SafeHtml {
    const file = this.selectedFile;
    const lang = file?.language || languageFromPath(file?.path || '') || this.current?.language || '';
    return this.sanitizer.bypassSecurityTrustHtml(highlightSource(file?.content || '', lang) + '\n');
  }

  highlightedRepoHtml(): SafeHtml {
    const file = this.repoOpenFile;
    const lang = file?.language || languageFromPath(file?.path || '');
    return this.sanitizer.bypassSecurityTrustHtml(highlightSource(file?.content || '', lang) + '\n');
  }

  highlightedChatHtml(content: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(highlightMarkdown(content || ''));
  }

  editorLangLabel(): string {
    const file = this.selectedFile;
    return file?.language || languageFromPath(file?.path || '') || this.current?.language || '';
  }

  syncEditorScroll(ev: Event): void {
    const t = ev.target as HTMLTextAreaElement;
    const pre = this.editorPre?.nativeElement;
    if (!pre) {
      return;
    }
    pre.scrollTop = t.scrollTop;
    pre.scrollLeft = t.scrollLeft;
  }

  toggleEditorFullscreen(): void {
    void this.toggleHostFullscreen(this.editorStage?.nativeElement, 'editor');
  }

  toggleRepoFullscreen(): void {
    void this.toggleHostFullscreen(this.repoPreviewStage?.nativeElement, 'repo');
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  @HostListener('document:mozfullscreenchange')
  onFullscreenChange(): void {
    if (!this.isFullscreenHost(this.editorStage?.nativeElement)) {
      this.editorCssFs = false;
    }
    if (!this.isFullscreenHost(this.repoPreviewStage?.nativeElement)) {
      this.repoCssFs = false;
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.editorCssFs) {
      this.editorCssFs = false;
    }
    if (this.repoCssFs) {
      this.repoCssFs = false;
    }
  }

  get isLoggedIn(): boolean {
    return this.keycloak.isLoggedIn();
  }

  get files(): CodeProjectFile[] {
    return this.current?.files ?? [];
  }

  get selectedFile(): CodeProjectFile | null {
    const files = this.files;
    if (!files.length) {
      return null;
    }
    const i = Math.min(Math.max(0, this.selectedFileIndex), files.length - 1);
    return files[i];
  }

  get chatTurns(): CodeChatTurn[] {
    return this.current?.chatTurns ?? [];
  }

  get provider(): AssistantProviderSlug {
    const p = this.current?.provider;
    return isAssistantProviderSlug(p) ? p : 'openai';
  }

  get model(): string {
    const custom = this.customModel.trim();
    if (custom) {
      return custom;
    }
    return (this.current?.model || this.models[0] || '').trim();
  }

  fileContentModel(): string {
    return this.selectedFile?.content ?? '';
  }

  onFileContentChange(value: string): void {
    const file = this.selectedFile;
    if (!file) {
      return;
    }
    file.content = value;
    this.markDirty();
  }

  reloadList(): void {
    if (!this.isLoggedIn) {
      return;
    }
    this.loadingList = true;
    this.codeApi.list().pipe(catchError(() => of([]))).subscribe({
      next: (rows) => {
        this.projects = rows || [];
        this.loadingList = false;
        if (!this.current && this.projects.length) {
          this.openProject(this.projects[0]);
        }
      },
      error: () => {
        this.loadingList = false;
        this.errorKey = 'CODE.ERROR_LOAD';
      }
    });
  }

  openProject(row: CodeProject): void {
    if (!row?.id) {
      return;
    }
    if (this.dirty && this.current?.id && this.current.id !== row.id) {
      this.saveCurrent(true);
    }
    this.loadingProject = true;
    this.errorKey = null;
    this.codeApi.getOne(row.id).subscribe({
      next: (full) => {
        this.current = this.normalizeProject(full);
        this.selectedFileIndex = 0;
        this.repoUrl = this.current.repoUrl || '';
        this.customModel = '';
        this.applyCandidates = [];
        this.dirty = false;
        this.loadingProject = false;
        this.loadModels(this.provider);
        this.scrollChat();
      },
      error: () => {
        this.loadingProject = false;
        this.errorKey = 'CODE.ERROR_LOAD';
      }
    });
  }

  newProject(): void {
    const name = this.translate.instant('CODE.NEW_PROJECT_NAME');
    const created: CodeProject = {
      name,
      description: '',
      language: 'java',
      repoUrl: '',
      files: [{ path: 'src/Main.java', content: 'public class Main {\n    public static void main(String[] args) {\n    }\n}\n', language: 'java' }],
      chatTurns: [],
      provider: this.provider,
      model: this.model
    };
    this.codeApi.create(this.toPayload(created)).subscribe({
      next: (saved) => {
        this.projects = [saved, ...this.projects];
        this.current = this.normalizeProject(saved);
        this.selectedFileIndex = 0;
        this.dirty = false;
        this.statusKey = 'CODE.SAVED';
      },
      error: () => {
        this.errorKey = 'CODE.ERROR_SAVE';
      }
    });
  }

  saveCurrent(silent = false): void {
    if (!this.current || this.saving) {
      return;
    }
    this.saving = true;
    const payload = this.toPayload(this.current);
    const req = this.current.id
      ? this.codeApi.update(this.current.id, payload)
      : this.codeApi.create(payload);
    req.subscribe({
      next: (saved) => {
        const keepChat = this.current?.chatTurns ?? saved.chatTurns;
        const keepFiles = this.current?.files ?? saved.files;
        this.current = this.normalizeProject({ ...saved, files: keepFiles, chatTurns: keepChat });
        this.dirty = false;
        this.saving = false;
        this.upsertListRow(this.current);
        if (!silent) {
          this.statusKey = 'CODE.SAVED';
        }
      },
      error: () => {
        this.saving = false;
        this.errorKey = 'CODE.ERROR_SAVE';
      }
    });
  }

  deleteCurrent(): void {
    if (!this.current?.id) {
      return;
    }
    if (!window.confirm(this.translate.instant('CODE.DELETE_CONFIRM'))) {
      return;
    }
    const id = this.current.id;
    this.codeApi.delete(id).subscribe({
      next: () => {
        this.projects = this.projects.filter((p) => p.id !== id);
        this.current = null;
        this.dirty = false;
        if (this.projects.length) {
          this.openProject(this.projects[0]);
        }
      },
      error: () => {
        this.errorKey = 'CODE.ERROR_SAVE';
      }
    });
  }

  addFile(): void {
    if (!this.current) {
      return;
    }
    const path = window.prompt(this.translate.instant('CODE.FILE_PATH'), 'src/NewFile.txt');
    if (!path || !path.trim()) {
      return;
    }
    const p = path.trim().replace(/\\/g, '/');
    this.current.files = this.current.files || [];
    this.current.files.push({ path: p, content: '', language: languageFromPath(p) });
    this.selectedFileIndex = this.current.files.length - 1;
    this.markDirty();
  }

  deleteFile(index: number): void {
    if (!this.current?.files) {
      return;
    }
    this.current.files.splice(index, 1);
    this.selectedFileIndex = Math.max(0, Math.min(index, this.current.files.length - 1));
    this.markDirty();
  }

  selectFile(index: number): void {
    this.selectedFileIndex = index;
  }

  onMetaChange(): void {
    this.markDirty();
  }

  onProviderChange(slug: string): void {
    if (!this.current || !isAssistantProviderSlug(slug)) {
      return;
    }
    this.current.provider = slug;
    this.customModel = '';
    this.loadModels(slug, true);
    this.markDirty();
  }

  onModelChange(model: string): void {
    if (!this.current) {
      return;
    }
    this.current.model = model;
    this.customModel = '';
    this.markDirty();
  }

  sendPrompt(): void {
    const text = this.draftPrompt.trim();
    if (!text || !this.current || this.sending) {
      return;
    }
    this.sending = true;
    this.errorKey = null;
    this.applyCandidates = [];
    const history = [...(this.current.chatTurns || [])];
    const userTurn: CodeChatTurn = { role: 'user', content: text };
    history.push(userTurn);
    this.current.chatTurns = history;
    this.draftPrompt = '';
    this.scrollChat();

    const context = text.length > 20_000 ? '' : this.buildFileContext();
    const userContent = context
      ? `${context}\n\n---\n${text}`
      : text;
    const messages: AssistantChatTurn[] = history.slice(-16).map((t, i, arr) => ({
      role: t.role,
      content: i === arr.length - 1 ? userContent : t.content
    }));

    this.assistant
      .sendMessages(messages, this.systemPrompt(), undefined, undefined, {
        provider: this.provider,
        model: this.model
      })
      .subscribe({
        next: (res) => {
          const content = (res.content || '').trim() || (res.error || '').trim();
          this.current!.chatTurns = [...(this.current!.chatTurns || []), { role: 'assistant', content }];
          this.applyCandidates = this.parseFileBlocks(content);
          this.sending = false;
          this.markDirty();
          this.scrollChat();
        },
        error: () => {
          this.sending = false;
          this.errorKey = 'CODE.ERROR_CHAT';
        }
      });
  }

  applyParsedFiles(): void {
    if (!this.current || !this.applyCandidates.length) {
      return;
    }
    this.current.files = this.current.files || [];
    for (const cand of this.applyCandidates) {
      const existing = this.current.files.find((f) => f.path === cand.path);
      if (existing) {
        existing.content = cand.content;
        existing.language = languageFromPath(cand.path);
      } else {
        this.current.files.push({
          path: cand.path,
          content: cand.content,
          language: languageFromPath(cand.path)
        });
      }
    }
    this.selectedFileIndex = Math.max(
      0,
      this.current.files.findIndex((f) => f.path === this.applyCandidates[0].path)
    );
    this.applyCandidates = [];
    this.markDirty();
    this.statusKey = 'CODE.FILES_APPLIED';
  }

  fetchRepo(): void {
    const url = this.repoUrl.trim();
    if (!url) {
      return;
    }
    this.openRepo(url, this.repoBranch);
  }

  searchRepos(example?: string): void {
    if (example) {
      this.repoSearchQuery = example;
    }
    const q = this.repoSearchQuery.trim();
    if (q.length < 2 || this.searchingRepos) {
      return;
    }
    if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(q) && this.repoSearchHost !== 'gitlab') {
      this.openRepo('https://github.com/' + q, '');
      return;
    }
    this.searchingRepos = true;
    this.errorKey = null;
    this.repoSearchInterpreted = '';
    this.repoSearchSummary = '';
    this.codeApi
      .searchRepos(q, this.repoSearchHost, undefined, {
        naturalLanguage: this.repoSearchNatural,
        provider: this.current?.provider,
        model: this.current?.model
      })
      .subscribe({
        next: (res) => {
          this.repoHits = res.items || [];
          this.searchingRepos = false;
          this.repoSearchInterpreted = (res.interpretedQuery || '').trim();
          this.repoSearchSummary = (res.summary || '').trim();
          this.statusKey = this.repoHits.length ? null : 'CODE.REPO_SEARCH_EMPTY';
        },
        error: (err) => {
          this.searchingRepos = false;
          this.repoHits = [];
          this.repoSearchInterpreted = '';
          this.repoSearchSummary = '';
          this.setRepoError(err);
        }
      });
  }

  openSearchHit(hit: CodeRepoSearchHit): void {
    const url = (hit.htmlUrl || '').trim();
    if (!url) {
      return;
    }
    this.repoUrl = url;
    this.repoBranch = (hit.defaultBranch || '').trim();
    this.openRepo(url, this.repoBranch);
  }

  openRepo(url: string, branch: string): void {
    this.repoUrl = url;
    this.repoBranch = branch || this.repoBranch;
    this.repoOpenFile = null;
    this.repoPreview = null;
    this.treeCache.clear();
    this.treeCacheRepo = '';
    this.repoFlat = null;
    this.loadTree('');
    this.startTreeIndex();
    if (this.current) {
      this.current.repoUrl = url;
      this.markDirty();
    }
  }

  loadTree(path: string): void {
    const url = this.repoUrl.trim();
    if (!url) {
      return;
    }
    const cacheKey = (path || '').replace(/^\/+|\/+$/g, '');
    if (this.repoFlat && this.repoFlat.length) {
      this.applyLocalTree(cacheKey);
      return;
    }
    const repoKey = url + '|' + this.repoBranch.trim();
    if (this.treeCacheRepo !== repoKey) {
      this.treeCache.clear();
      this.treeCacheRepo = repoKey;
    }
    const cached = this.treeCache.get(cacheKey);
    if (cached) {
      this.repoTree = cached;
      this.repoTreePath = cached.path || cacheKey;
      this.loadingTree = false;
      return;
    }
    const req = ++this.treeReq;
    this.loadingTree = true;
    this.errorKey = null;
    this.codeApi.repoTree(url, this.repoBranch, path).subscribe({
      next: (tree) => {
        if (req !== this.treeReq) {
          return;
        }
        this.applyTreeResponse(tree, path);
        this.treeCache.set(cacheKey, tree);
        this.loadingTree = false;
      },
      error: (err) => {
        if (req !== this.treeReq) {
          return;
        }
        this.loadingTree = false;
        this.setRepoError(err);
      }
    });
  }

  private startTreeIndex(): void {
    const url = this.repoUrl.trim();
    if (!url) {
      return;
    }
    const req = ++this.indexReq;
    this.codeApi.repoTreeIndex(url, this.repoBranch).subscribe({
      next: (res) => {
        if (req !== this.indexReq) {
          return;
        }
        const nodes = res.nodes || [];
        if (!nodes.length) {
          return;
        }
        this.repoFlat = nodes;
        if (res.defaultBranch && !this.repoBranch.trim()) {
          this.repoBranch = res.defaultBranch;
        }
        this.treeReq++;
        this.applyLocalTree(this.repoTreePath || '');
      },
      error: () => {
        /* Folder clicks still work via per-directory API. */
      }
    });
  }

  private applyTreeResponse(tree: CodeRepoTreeResponse, path: string): void {
    this.repoTree = tree;
    this.repoTreePath = tree.path || path || '';
    if (tree.defaultBranch && !this.repoBranch.trim()) {
      this.repoBranch = tree.defaultBranch;
    }
    if (tree.htmlUrl) {
      this.repoUrl = tree.htmlUrl;
    }
    this.treeCacheRepo = this.repoUrl.trim() + '|' + this.repoBranch.trim();
  }

  private applyLocalTree(path: string): void {
    const rel = (path || '').replace(/^\/+|\/+$/g, '');
    const prefix = rel ? rel + '/' : '';
    const byName = new Map<string, CodeRepoTreeEntry>();
    for (const node of this.repoFlat || []) {
      const p = node.path || '';
      if (prefix && !p.startsWith(prefix)) {
        continue;
      }
      const rest = prefix ? p.slice(prefix.length) : p;
      if (!rest) {
        continue;
      }
      const slash = rest.indexOf('/');
      if (slash < 0) {
        byName.set(rest, {
          name: rest,
          path: p,
          type: node.type === 'dir' ? 'dir' : 'file',
          size: node.size
        });
      } else {
        const dirName = rest.slice(0, slash);
        if (!byName.has(dirName)) {
          byName.set(dirName, {
            name: dirName,
            path: prefix + dirName,
            type: 'dir',
            size: 0
          });
        }
      }
    }
    const entries = [...byName.values()].sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'dir' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    this.repoTree = {
      host: this.repoTree?.host,
      owner: this.repoTree?.owner,
      name: this.repoTree?.name,
      htmlUrl: this.repoUrl,
      defaultBranch: this.repoBranch,
      path: rel,
      entries
    };
    this.repoTreePath = rel;
    this.loadingTree = false;
  }

  openTreeEntry(entry: CodeRepoTreeEntry): void {
    if (entry.type === 'dir') {
      this.repoOpenFile = null;
      this.loadTree(entry.path);
      return;
    }
    this.openRepoFile(entry.path);
  }

  goTreeParent(): void {
    const path = this.repoTreePath.replace(/\/+$/, '');
    if (!path) {
      return;
    }
    const slash = path.lastIndexOf('/');
    this.loadTree(slash > 0 ? path.slice(0, slash) : '');
  }

  goTreeCrumb(index: number): void {
    const parts = this.treeCrumbs;
    if (index < 0) {
      this.loadTree('');
      return;
    }
    this.loadTree(parts.slice(0, index + 1).join('/'));
  }

  get treeCrumbs(): string[] {
    return (this.repoTreePath || '').split('/').filter((p) => p.length > 0);
  }

  openRepoFile(path: string): void {
    const url = this.repoUrl.trim();
    if (!url || this.loadingRepoFile) {
      return;
    }
    this.loadingRepoFile = true;
    this.errorKey = null;
    this.codeApi.repoFile(url, path, this.repoBranch).subscribe({
      next: (file) => {
        this.repoOpenFile = file;
        this.loadingRepoFile = false;
      },
      error: (err) => {
        this.loadingRepoFile = false;
        this.repoOpenFile = null;
        this.setRepoError(err);
      }
    });
  }

  importOpenFile(): void {
    if (!this.current || !this.repoOpenFile) {
      this.errorKey = this.current ? 'CODE.ERROR_REPO' : 'CODE.NO_PROJECT';
      return;
    }
    this.current.files = this.current.files || [];
    const existing = this.current.files.find((f) => f.path === this.repoOpenFile!.path);
    if (existing) {
      existing.content = this.repoOpenFile.content;
      existing.language = this.repoOpenFile.language || languageFromPath(this.repoOpenFile.path);
    } else {
      this.current.files.push({
        path: this.repoOpenFile.path,
        content: this.repoOpenFile.content,
        language: this.repoOpenFile.language || languageFromPath(this.repoOpenFile.path)
      });
    }
    this.selectedFileIndex = this.current.files.findIndex((f) => f.path === this.repoOpenFile!.path);
    this.markDirty();
    this.statusKey = 'CODE.REPO_FILE_IMPORTED';
  }

  analyzeOpenFile(): void {
    if (!this.current || !this.repoOpenFile || this.sending) {
      this.errorKey = this.current ? null : 'CODE.NO_PROJECT';
      return;
    }
    const f = this.repoOpenFile;
    this.draftPrompt =
      this.translate.instant('CODE.REPO_FILE_ANALYZE_PROMPT', { file: f.path }) +
      `\n\n### FILE: ${f.path}\n\`\`\`${f.language || ''}\n${f.content}\n\`\`\``;
    this.sendPrompt();
  }

  fetchRepoSubset(): void {
    const url = this.repoUrl.trim();
    if (!url || this.fetchingRepo) {
      return;
    }
    this.fetchingRepo = true;
    this.errorKey = null;
    this.codeApi.analyzeRepo(url, this.repoBranch).subscribe({
      next: (res) => {
        this.repoPreview = res;
        this.fetchingRepo = false;
        if (this.current) {
          this.current.repoUrl = res.htmlUrl || url;
          this.markDirty();
        }
      },
      error: (err) => {
        this.fetchingRepo = false;
        this.setRepoError(err);
      }
    });
  }

  importRepoFiles(): void {
    if (!this.current || !this.repoPreview?.files?.length) {
      return;
    }
    this.current.files = this.repoPreview.files.map((f) => ({
      path: f.path,
      content: f.content,
      language: f.language || languageFromPath(f.path)
    }));
    this.selectedFileIndex = 0;
    this.markDirty();
    this.statusKey = 'CODE.REPO_IMPORTED';
  }

  analyzeRepoWithAi(): void {
    if (!this.repoPreview?.files?.length || this.sending) {
      return;
    }
    if (!this.current) {
      this.errorKey = 'CODE.NO_PROJECT';
      return;
    }
    const header = `${this.repoPreview.owner}/${this.repoPreview.name} (${this.repoPreview.host})`;
    const chunks = this.repoPreview.files
      .map((f) => `### FILE: ${f.path}\n\`\`\`${f.language || ''}\n${f.content}\n\`\`\``)
      .join('\n\n');
    this.draftPrompt = this.translate.instant('CODE.REPO_ANALYZE_PROMPT', { repo: header }) + '\n\n' + chunks;
    this.sendPrompt();
  }

  markDirty(): void {
    this.dirty = true;
    this.persist$.next();
  }

  private bootstrapRouting(): void {
    this.assistant.getAssistantClientConfig().subscribe((cfg) => {
      const slug = isAssistantProviderSlug(cfg.routingDefault || undefined)
        ? (cfg.routingDefault as AssistantProviderSlug)
        : 'openai';
      if (this.current && !this.current.provider) {
        this.current.provider = slug;
      }
      this.loadModels(this.current?.provider && isAssistantProviderSlug(this.current.provider)
        ? this.current.provider
        : slug);
    });
  }

  private loadModels(provider: AssistantProviderSlug, pickFirst = false): void {
    const fallback = this.presetsFor(provider);
    this.models = [...fallback];
    this.assistant.getAssistantModels(provider).subscribe((ids) => {
      const merged = [...new Set([...(ids || []), ...fallback])].filter((x) => x.trim());
      merged.sort((a, b) => a.localeCompare(b));
      this.models = merged.length ? merged : fallback;
      if (!this.current) {
        return;
      }
      if (pickFirst || !this.current.model || !this.models.includes(this.current.model)) {
        this.current.model = this.models[0] || fallback[0];
      }
    });
  }

  private presetsFor(provider: AssistantProviderSlug): string[] {
    switch (provider) {
      case 'anthropic':
        return [...ASSISTANT_ANTHROPIC_MODEL_PRESETS];
      case 'gemini':
        return [...ASSISTANT_GEMINI_MODEL_PRESETS];
      case 'mistral':
        return [...ASSISTANT_MISTRAL_MODEL_PRESETS];
      case 'spacexai':
        return [...ASSISTANT_SPACEXAI_MODEL_PRESETS];
      default:
        return [...ASSISTANT_OPENAI_MODEL_PRESETS];
    }
  }

  private systemPrompt(): string {
    const lang = (this.translate.currentLang || 'fr').toLowerCase();
    if (lang.startsWith('fr')) {
      return [
        'Tu es PatTool Code, assistant logiciel spécialisé en sécurité applicative.',
        'Tu écris du code de production dans n’importe quel langage demandé.',
        'Priorités : validation des entrées, requêtes paramétrées, moindre privilège, secrets hors du code, authn/authz, défenses XSS/CSRF/injection, désérialisation sûre, dépendances saines.',
        'Pour une revue : identifie les failles, gravité, fichier, et fournis un correctif. Ne fournis jamais d’exploit, de payload d’attaque ni de procédure de piratage.',
        'Refuse malware, rançongiciel, et toute aide à attaquer un système dont l’utilisateur n’est pas responsable.',
        'Quand tu crées ou modifies des fichiers, utilise exactement :',
        '### FILE: chemin/relatif.ext',
        '```langage',
        '...code...',
        '```'
      ].join('\n');
    }
    return [
      'You are PatTool Code, a software assistant specialized in application security.',
      'Write production-quality code in any language the user requests.',
      'Prioritize input validation, parameterized queries, least privilege, secret hygiene, authn/z, XSS/CSRF/injection defenses, safe deserialization, and healthy dependencies.',
      'When reviewing code, identify issues with severity, file, and a patch. Never provide exploits, attack payloads, or hacking procedures.',
      'Refuse malware, ransomware, and help attacking systems the user does not own or operate.',
      'When creating or changing files, use exactly:',
      '### FILE: relative/path.ext',
      '```language',
      '...code...',
      '```'
    ].join('\n');
  }

  private buildFileContext(): string {
    const files = this.files.filter((f) => (f.path || '').trim());
    if (!files.length) {
      return '';
    }
    let budget = 60_000;
    const parts: string[] = ['Project files:'];
    for (const f of files) {
      const body = f.content || '';
      const slice = body.length > budget ? body.slice(0, budget) : body;
      parts.push(`### FILE: ${f.path}\n\`\`\`${f.language || ''}\n${slice}\n\`\`\``);
      budget -= slice.length;
      if (budget <= 0) {
        parts.push('(truncated)');
        break;
      }
    }
    return parts.join('\n\n');
  }

  parseFileBlocks(text: string): { path: string; content: string }[] {
    const out: { path: string; content: string }[] = [];
    const re = /###\s*FILE:\s*([^\n]+)\n```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      const path = m[1].trim().replace(/\\/g, '/');
      if (path && !path.includes('..')) {
        out.push({ path, content: m[2].replace(/\n$/, '') });
      }
    }
    return out;
  }

  private normalizeProject(p: CodeProject): CodeProject {
    return {
      ...p,
      files: p.files?.length ? p.files : [],
      chatTurns: p.chatTurns?.length ? p.chatTurns : [],
      provider: isAssistantProviderSlug(p.provider) ? p.provider : 'openai'
    };
  }

  private toPayload(p: CodeProject): CodeProject {
    return {
      name: (p.name || 'project').trim(),
      description: p.description || '',
      language: p.language || '',
      repoUrl: this.repoUrl.trim() || p.repoUrl || '',
      files: (p.files || []).map((f) => ({
        path: f.path,
        content: f.content || '',
        language: f.language || languageFromPath(f.path)
      })),
      chatTurns: (p.chatTurns || []).map((t) => ({ role: t.role, content: t.content })),
      provider: p.provider || this.provider,
      model: this.customModel.trim() || p.model || this.model
    };
  }

  private upsertListRow(p: CodeProject): void {
    if (!p.id) {
      return;
    }
    const i = this.projects.findIndex((x) => x.id === p.id);
    const slim: CodeProject = {
      ...p,
      files: (p.files || []).map((f) => ({ path: f.path, language: f.language })),
      chatTurns: []
    };
    if (i >= 0) {
      this.projects[i] = slim;
    } else {
      this.projects = [slim, ...this.projects];
    }
  }

  private scrollChat(): void {
    queueMicrotask(() => {
      const el = this.chatScroll?.nativeElement;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  private setRepoError(err: { error?: { error?: string } } | null): void {
    const apiErr = err?.error?.error;
    if (typeof apiErr === 'string' && apiErr.trim()) {
      this.errorKey = null;
      this.statusKey = null;
      this.repoPreview = { error: apiErr, files: [] };
      return;
    }
    this.errorKey = 'CODE.ERROR_REPO';
  }

  private isFullscreenHost(el?: HTMLElement | null): boolean {
    return !!el && CodeComponent.fullscreenElement() === el;
  }

  private async toggleHostFullscreen(el: HTMLElement | undefined, which: 'editor' | 'repo'): Promise<void> {
    if (!el) {
      return;
    }
    if (this.isFullscreenHost(el) || (which === 'editor' ? this.editorCssFs : this.repoCssFs)) {
      await this.exitOwnedFullscreen();
      this.editorCssFs = false;
      this.repoCssFs = false;
      return;
    }
    try {
      await CodeComponent.requestFullscreen(el);
    } catch {
      if (which === 'editor') {
        this.editorCssFs = true;
        this.repoCssFs = false;
      } else {
        this.repoCssFs = true;
        this.editorCssFs = false;
      }
    }
  }

  private async exitOwnedFullscreen(): Promise<void> {
    const cur = CodeComponent.fullscreenElement();
    const ours =
      cur === this.editorStage?.nativeElement || cur === this.repoPreviewStage?.nativeElement;
    if (!ours) {
      return;
    }
    const doc = document as Document & {
      webkitExitFullscreen?: () => void;
      mozCancelFullScreen?: () => void;
    };
    try {
      if (typeof document.exitFullscreen === 'function') {
        await document.exitFullscreen();
      } else {
        doc.webkitExitFullscreen?.();
        doc.mozCancelFullScreen?.();
      }
    } catch {
      /* ignore */
    }
  }

  private static fullscreenElement(): Element | null {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      mozFullScreenElement?: Element | null;
    };
    return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? doc.mozFullScreenElement ?? null;
  }

  private static requestFullscreen(el: HTMLElement): Promise<void> {
    const anyEl = el as HTMLElement & {
      webkitRequestFullscreen?: () => void;
      mozRequestFullScreen?: () => void;
    };
    if (typeof el.requestFullscreen === 'function') {
      return el.requestFullscreen();
    }
    if (typeof anyEl.webkitRequestFullscreen === 'function') {
      anyEl.webkitRequestFullscreen();
      return Promise.resolve();
    }
    if (typeof anyEl.mozRequestFullScreen === 'function') {
      anyEl.mozRequestFullScreen();
      return Promise.resolve();
    }
    return Promise.reject(new Error('fullscreen unsupported'));
  }
}
