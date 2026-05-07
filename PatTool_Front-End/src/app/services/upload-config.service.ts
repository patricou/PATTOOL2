import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, from, Observable, of } from 'rxjs';
import { catchError, map, shareReplay, switchMap, take, tap } from 'rxjs/operators';

import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';

/**
 * Configuration d'upload exposée par le backend (lecture seule).
 *
 * `imageMaxSizeKb` provient de la propriété `app.imagemaxsizekb` du fichier
 * `application.properties`. Le frontend l'utilise pour décider si la modale
 * de compression doit afficher un switch ou simplement informer l'utilisateur
 * que l'image est déjà ≤ à la limite configurée.
 */
export interface UploadConfig {
    imageMaxSizeKb: number;
}

interface UploadConfigDto {
    imageMaxSizeKb?: number | string | null;
}

@Injectable({ providedIn: 'root' })
export class UploadConfigService {
    /**
     * Valeur par défaut utilisée tant que l'appel backend n'a pas encore
     * répondu, ou en cas d'erreur réseau. Aligné sur le défaut du backend
     * (`@Value("${app.imagemaxsizekb:500}")`) — surchargé dès la première
     * réponse.
     */
    private static readonly DEFAULT_IMAGE_MAX_SIZE_KB = 500;

    private cached$?: Observable<UploadConfig>;
    private currentImageMaxSizeKb: number = UploadConfigService.DEFAULT_IMAGE_MAX_SIZE_KB;

    constructor(
        private http: HttpClient,
        private keycloakService: KeycloakService
    ) {}

    /**
     * Récupère la config (avec cache mémoire `shareReplay`). Lance la requête
     * HTTP au premier appel, puis renvoie la valeur mise en cache.
     */
    getUploadConfig(): Observable<UploadConfig> {
        if (!this.cached$) {
            const url = `${environment.API_URL}file/upload-config`;
            this.cached$ = from(this.keycloakService.getToken()).pipe(
                switchMap((token: string) =>
                    this.http.get<UploadConfigDto>(url, {
                        headers: { Authorization: 'Bearer ' + token }
                    })
                ),
                map((dto): UploadConfig => ({
                    imageMaxSizeKb: this.toPositiveInt(
                        dto?.imageMaxSizeKb,
                        UploadConfigService.DEFAULT_IMAGE_MAX_SIZE_KB
                    )
                })),
                tap((cfg) => {
                    this.currentImageMaxSizeKb = cfg.imageMaxSizeKb;
                }),
                catchError(() => of<UploadConfig>({
                    imageMaxSizeKb: this.currentImageMaxSizeKb
                })),
                shareReplay({ bufferSize: 1, refCount: false })
            );
        }
        return this.cached$;
    }

    /**
     * Pré-charge la valeur (à appeler par exemple dans `ngOnInit`) pour que
     * `getImageMaxSizeKbSync()` renvoie la vraie valeur lors d'une décision
     * synchrone (ouverture d'un modal après sélection de fichiers).
     */
    preload(): void {
        this.getUploadConfig().subscribe({ next: () => undefined, error: () => undefined });
    }

    /**
     * Attend explicitement la valeur `app.imagemaxsizekb` renvoyée par le backend.
     *
     * À utiliser **avant** d'ouvrir une modale ou de comparer des tailles de fichiers :
     * `getImageMaxSizeKbSync()` peut encore valoir le fallback (500) si `preload()`
     * n'a pas fini ou si aucune requête n'a encore été faite.
     */
    async resolveImageMaxSizeKb(): Promise<number> {
        const cfg = await firstValueFrom(this.getUploadConfig().pipe(take(1)));
        return cfg.imageMaxSizeKb;
    }

    /**
     * Dernière valeur connue de `imageMaxSizeKb`. Renvoie un fallback (500)
     * tant que la première requête n'a pas répondu.
     */
    getImageMaxSizeKbSync(): number {
        return this.currentImageMaxSizeKb;
    }

    /**
     * Sépare une liste de fichiers (typiquement les images) en deux groupes
     * selon le seuil `imageMaxSizeKb` :
     *  - `under` : fichiers ≤ seuil (n'ont PAS besoin d'être compressés)
     *  - `over`  : fichiers > seuil (candidats à compression)
     *
     * @param files Fichiers (uniquement les images attendues — laisser au
     * caller le soin de filtrer par MIME).
     */
    splitBySize(files: File[]): { under: File[]; over: File[]; thresholdKb: number } {
        const thresholdKb = this.getImageMaxSizeKbSync();
        const thresholdBytes = thresholdKb * 1024;
        const under: File[] = [];
        const over: File[] = [];
        for (const f of files) {
            if (f.size <= thresholdBytes) {
                under.push(f);
            } else {
                over.push(f);
            }
        }
        return { under, over, thresholdKb };
    }

    /**
     * Vrai si la taille (en octets) est ≤ au seuil configuré côté backend.
     * Renseigne aussi la limite (en KB) à l'appelant si nécessaire pour
     * l'affichage du message « image déjà petite ».
     */
    isUnderImageMaxSize(sizeBytes: number): boolean {
        const thresholdBytes = this.getImageMaxSizeKbSync() * 1024;
        return Number.isFinite(sizeBytes) && sizeBytes <= thresholdBytes;
    }

    private toPositiveInt(raw: unknown, fallback: number): number {
        const n = typeof raw === 'string' ? parseInt(raw, 10) : (typeof raw === 'number' ? raw : NaN);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
    }
}
