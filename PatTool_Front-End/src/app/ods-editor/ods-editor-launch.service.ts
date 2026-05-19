import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';

/** Ouvre l’éditeur ODS avec un fichier pièce jointe d’événement (GridFS). */
@Injectable({ providedIn: 'root' })
export class OdsEditorLaunchService {
  private readonly router = inject(Router);

  openEventFile(fieldId: string, fileName: string): void {
    const id = (fieldId ?? '').trim();
    if (!id) {
      return;
    }
    const name = (fileName ?? '').trim() || 'document.ods';
    void this.router.navigate(['/tools/ods-editor'], {
      queryParams: {
        fileId: id,
        fileName: name
      }
    });
  }
}
