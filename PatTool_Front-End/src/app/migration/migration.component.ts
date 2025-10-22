import { Component, OnInit } from '@angular/core';
import { MigrationService } from '../services/migration.service';

@Component({
  selector: 'app-migration',
  template: `
    <div class="container mt-4">
      <div class="card">
        <div class="card-header">
          <h3><i class="fa fa-database"></i> Migration des données</h3>
        </div>
        <div class="card-body">
          <!-- Migration Map → UrlEvents -->
          <div class="alert alert-info">
            <h5><i class="fa fa-info-circle"></i> Migration Map → UrlEvents</h5>
            <p>Cette migration va déplacer les données du champ <code>map</code> vers le nouveau système <code>urlEvents</code>.</p>
            <ul>
              <li><strong>typeUrl:</strong> MAP</li>
              <li><strong>owner:</strong> Patricou</li>
              <li><strong>urlDescription:</strong> Carte</li>
              <li><strong>link:</strong> Valeur du champ map</li>
            </ul>
          </div>

          <div class="row">
            <div class="col-md-6">
              <button class="btn btn-info btn-block" (click)="checkStatus()" [disabled]="loading">
                <i class="fa fa-info-circle"></i> Vérifier le statut Map
              </button>
            </div>
            <div class="col-md-6">
              <button class="btn btn-warning btn-block" (click)="executeMigration()" [disabled]="loading">
                <i class="fa fa-play"></i> Exécuter migration Map
              </button>
            </div>
          </div>

          <hr class="my-4">

          <!-- Migration Photos → UrlEvents -->
          <div class="alert alert-success">
            <h5><i class="fa fa-camera"></i> Migration Photos → UrlEvents</h5>
            <p>Cette migration va déplacer les données du champ <code>photosUrl</code> vers le nouveau système <code>urlEvents</code>.</p>
            <ul>
              <li><strong>typeUrl:</strong> Photos</li>
              <li><strong>owner:</strong> Patricou</li>
              <li><strong>urlDescription:</strong> Photos</li>
              <li><strong>link:</strong> Valeur de chaque URL de photo</li>
            </ul>
          </div>

          <div class="row">
            <div class="col-md-6">
              <button class="btn btn-info btn-block" (click)="checkPhotosStatus()" [disabled]="loading">
                <i class="fa fa-info-circle"></i> Vérifier le statut Photos
              </button>
            </div>
            <div class="col-md-6">
              <button class="btn btn-success btn-block" (click)="executePhotosMigration()" [disabled]="loading">
                <i class="fa fa-camera"></i> Exécuter migration Photos
              </button>
            </div>
          </div>

          <div *ngIf="loading" class="text-center mt-3">
            <i class="fa fa-spinner fa-spin fa-2x"></i>
            <p>Migration en cours...</p>
          </div>

          <div *ngIf="statusMessage" class="alert alert-info mt-3">
            <h6><i class="fa fa-info-circle"></i> Statut:</h6>
            <pre>{{ statusMessage }}</pre>
          </div>

          <div *ngIf="resultMessage" class="alert alert-success mt-3">
            <h6><i class="fa fa-check-circle"></i> Résultat:</h6>
            <p>{{ resultMessage }}</p>
          </div>

          <div *ngIf="errorMessage" class="alert alert-danger mt-3">
            <h6><i class="fa fa-exclamation-triangle"></i> Erreur:</h6>
            <p>{{ errorMessage }}</p>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .card {
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    
    .btn {
      margin-bottom: 10px;
    }
    
    pre {
      background-color: #f8f9fa;
      padding: 10px;
      border-radius: 4px;
      white-space: pre-wrap;
    }
    
    .alert {
      border-left: 4px solid;
    }
    
    .alert-info {
      border-left-color: #17a2b8;
    }
    
    .alert-success {
      border-left-color: #28a745;
    }
    
    .alert-danger {
      border-left-color: #dc3545;
    }
  `]
})
export class MigrationComponent implements OnInit {
  loading = false;
  statusMessage = '';
  resultMessage = '';
  errorMessage = '';

  constructor(private migrationService: MigrationService) { }

  ngOnInit() {
    // Automatically check status on component load
    this.checkStatus();
  }

  checkStatus() {
    this.loading = true;
    this.errorMessage = '';
    this.resultMessage = '';

    // Try frontend method first, fallback to backend method
    this.migrationService.getMigrationStatusFrontend().subscribe({
      next: (status: string) => {
        this.statusMessage = status;
        this.loading = false;
      },
      error: (error: any) => {
        // If frontend method fails, try backend method
        this.migrationService.getMigrationStatus().subscribe({
          next: (status: string) => {
            this.statusMessage = status;
            this.loading = false;
          },
          error: (backendError: any) => {
            this.errorMessage = 'Erreur lors de la vérification du statut: ' + 
              (error.message || 'Frontend: ' + error.message + ' | Backend: ' + backendError.message);
            this.loading = false;
          }
        });
      }
    });
  }

  executeMigration() {
    this.loading = true;
    this.errorMessage = '';
    this.resultMessage = '';
    this.statusMessage = '';

    // Try frontend method first, fallback to backend method
    this.migrationService.migrateMapToUrlEventsFrontend().subscribe({
      next: (result: string) => {
        this.resultMessage = result;
        this.loading = false;
        // Refresh status after migration
        setTimeout(() => this.checkStatus(), 1000);
      },
      error: (error: any) => {
        // If frontend method fails, try backend method
        this.migrationService.migrateMapToUrlEvents().subscribe({
          next: (result: string) => {
            this.resultMessage = result;
            this.loading = false;
            // Refresh status after migration
            setTimeout(() => this.checkStatus(), 1000);
          },
          error: (backendError: any) => {
            this.errorMessage = 'Erreur lors de la migration: ' + 
              (error.message || 'Frontend: ' + error.message + ' | Backend: ' + backendError.message);
            this.loading = false;
          }
        });
      }
    });
  }

  checkPhotosStatus() {
    this.loading = true;
    this.errorMessage = '';
    this.resultMessage = '';

    // Try backend method first, fallback to frontend method
    this.migrationService.getPhotosMigrationStatus().subscribe({
      next: (status: string) => {
        this.statusMessage = status;
        this.loading = false;
      },
      error: (error: any) => {
        // If backend method fails, try frontend method
        this.migrationService.getPhotosMigrationStatusFrontend().subscribe({
          next: (status: string) => {
            this.statusMessage = status;
            this.loading = false;
          },
          error: (frontendError: any) => {
            this.errorMessage = 'Erreur lors de la vérification du statut des photos: ' + 
              (error.message || 'Backend: ' + error.message + ' | Frontend: ' + frontendError.message);
            this.loading = false;
          }
        });
      }
    });
  }

  executePhotosMigration() {
    this.loading = true;
    this.errorMessage = '';
    this.resultMessage = '';
    this.statusMessage = '';

    // Try backend method first, fallback to frontend method
    this.migrationService.migratePhotosToUrlEvents().subscribe({
      next: (result: string) => {
        this.resultMessage = result;
        this.loading = false;
        // Refresh status after migration
        setTimeout(() => this.checkPhotosStatus(), 1000);
      },
      error: (error: any) => {
        // If backend method fails, try frontend method
        this.migrationService.migratePhotosToUrlEventsFrontend().subscribe({
          next: (result: string) => {
            this.resultMessage = result;
            this.loading = false;
            // Refresh status after migration
            setTimeout(() => this.checkPhotosStatus(), 1000);
          },
          error: (frontendError: any) => {
            this.errorMessage = 'Erreur lors de la migration des photos: ' + 
              (error.message || 'Backend: ' + error.message + ' | Frontend: ' + frontendError.message);
            this.loading = false;
          }
        });
      }
    });
  }
}
