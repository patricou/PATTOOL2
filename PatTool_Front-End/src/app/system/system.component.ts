import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders, HttpClientModule } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AgGridModule } from 'ag-grid-angular';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { CacheService } from '../services/cache.service';
import { ExceptionReportService } from '../services/exception-report.service';
import { MembersService } from '../services/members.service';
import { Member } from '../model/member';
import { UserConnectionLog } from '../model/user-connection-log';
import { ElementEvenementComponent } from '../evenements/element-evenement/element-evenement.component';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { KeycloakService } from '../keycloak/keycloak.service';
import { environment } from '../../environments/environment';
import { Observable, from, of } from 'rxjs';
import { switchMap, catchError } from 'rxjs/operators';
import { ColDef, GridOptions, GridReadyEvent } from 'ag-grid-community';
import { DiscussionService } from '../services/discussion.service';

@Component({
  selector: 'app-system',
  templateUrl: './system.component.html',
  styleUrls: ['./system.component.css'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    HttpClientModule,
    TranslateModule,
    AgGridModule,
    NgbModule,
    NavigationButtonsModule
  ]
})
export class SystemComponent implements OnInit {

  saveMessage: string = '';
  loadMessage: string = '';
  clearMessage: string = '';
  saveMessageVisible: boolean = false;
  loadMessageVisible: boolean = false;
  clearMessageVisible: boolean = false;
  isSaving: boolean = false;
  isLoading: boolean = false;
  isClearing: boolean = false;
  isShuttingDown: boolean = false;
  shutdownMessage: string = '';
  shutdownMessageVisible: boolean = false;
  isShutdownAuthorized: boolean = false;
  isClearCacheAuthorized: boolean = false;
  isDeleteConnectionLogsAuthorized: boolean = false;
  isSaveCacheAuthorized: boolean = false;
  isLoadCacheAuthorized: boolean = false;
  user: Member = new Member("", "", "", "", "", [], "");

  // Cache Statistics
  cacheStats: any = null;
  frontendCacheStats: any = null;
  isLoadingStats: boolean = false;
  statsError: string = '';

  // Performance Statistics
  performanceStats: any = null;
  private pageLoadStartTime: number = 0;

  // Additional Debug Info (from home-evenements)
  fileThumbnailsCacheCount: number = 0;
  pendingThumbnailLoadsCount: number = 0;
  compressionCacheCount: number = 0;
  compressionCacheSizeMB: number = 0;
  hostMemoryUsage: string = 'N/A';
  hostMemoryUsagePercent: number = 0;
  jvmMemoryUsage: string = 'N/A';
  jvmMemoryUsagePercent: number = 0;
  jvmStatus: string = 'OK';
  isLoadingAdditionalStats: boolean = false;

  // Exception Report properties
  isSendingReport: boolean = false;
  reportMessage: string = '';
  reportError: string = '';
  isLoadingPreview: boolean = false;
  previewError: string = '';
  reportHtml: SafeHtml | null = null;
  isPreviewVisible: boolean = false;

  constructor(
    private _cacheService: CacheService,
    private exceptionReportService: ExceptionReportService,
    private sanitizer: DomSanitizer,
    private translate: TranslateService,
    private _memberService: MembersService,
    private _http: HttpClient,
    private _keycloakService: KeycloakService,
    private discussionService: DiscussionService
  ) { }

  // Connection Logs properties
  isConnectionLogsVisible: boolean = false;
  isLoadingConnectionLogs: boolean = false;
  connectionLogs: UserConnectionLog[] = [];
  connectionLogsError: string = '';
  connectionLogsStartDate: Date = new Date();
  connectionLogsEndDate: Date = new Date();
  connectionLogsCount: number = 0;
  isDeletingConnectionLogs: boolean = false;
  deleteConnectionLogsMessage: string = '';
  deleteConnectionLogsMessageVisible: boolean = false;

  // Active Discussion Connections properties
  activeDiscussionConnections: any[] = [];
  isLoadingActiveConnections: boolean = false;
  activeConnectionsError: string = '';
  activeConnectionsCount: number = 0;
  
  // AG Grid properties
  connectionLogsColumnDefs: ColDef[] = [];
  connectionLogsGridOptions: GridOptions = {
    theme: 'legacy', // Use legacy CSS theme to avoid conflict with new Theming API
    defaultColDef: {
      sortable: true,
      filter: true,
      resizable: true,
      flex: 1,
      minWidth: 150,
      cellStyle: { display: 'flex', alignItems: 'center', verticalAlign: 'middle' },
      wrapText: true,
      autoHeight: true
    },
    pagination: true,
    paginationPageSize: 20,
    paginationPageSizeSelector: [10, 20, 50, 100],
    animateRows: true,
    rowSelection: 'single',
    suppressRowClickSelection: false
  };

  ngOnInit() {
    this.user = this._memberService.getUser();
    // Check authorization based on roles (Iot or Admin)
    this.checkAuthorizations();
    this.loadCacheStats();
    this.pageLoadStartTime = performance.now();
    this.collectPerformanceStats();
    this.loadAdditionalDebugInfo();
    
    // Initialize connection logs date range (1 day ago to now for better performance)
    this.connectionLogsEndDate = new Date();
    this.connectionLogsStartDate = new Date();
    this.connectionLogsStartDate.setDate(this.connectionLogsStartDate.getDate() - 1);
    
    // Initialize AG Grid column definitions
    this.initializeConnectionLogsColumns();
    
    // Load active discussion connections on init
    this.loadActiveDiscussionConnections();
  }

  /**
   * Check all authorizations based on user roles (Admin role for system operations)
   */
  checkAuthorizations(): void {
    // Check Admin role
    const hasAdminAccess = this._keycloakService.hasAdminRole();
    
    this.isShutdownAuthorized = hasAdminAccess;
    this.isClearCacheAuthorized = hasAdminAccess;
    this.isDeleteConnectionLogsAuthorized = hasAdminAccess;
    this.isSaveCacheAuthorized = hasAdminAccess;
    this.isLoadCacheAuthorized = hasAdminAccess;
    
    // Also check again after a short delay in case Keycloak wasn't fully initialized
    setTimeout(() => {
      const hasAdminAccessDelayed = this._keycloakService.hasAdminRole();
      if (hasAdminAccessDelayed !== hasAdminAccess) {
        this.isShutdownAuthorized = hasAdminAccessDelayed;
        this.isClearCacheAuthorized = hasAdminAccessDelayed;
        this.isDeleteConnectionLogsAuthorized = hasAdminAccessDelayed;
        this.isSaveCacheAuthorized = hasAdminAccessDelayed;
        this.isLoadCacheAuthorized = hasAdminAccessDelayed;
      }
    }, 500);
  }
  
  initializeConnectionLogsColumns(): void {
    this.connectionLogsColumnDefs = [
      {
        field: 'connectionDate',
        headerName: this.translate.instant('SYSTEM.CONNECTION_LOGS.DATE_TIME'),
        width: 200,
        valueFormatter: (params) => {
          return params.value ? this.formatConnectionDate(params.value) : 'N/A';
        },
        comparator: (valueA, valueB) => {
          const dateA = valueA ? new Date(valueA).getTime() : 0;
          const dateB = valueB ? new Date(valueB).getTime() : 0;
          return dateA - dateB;
        }
      },
      {
        field: 'type',
        headerName: this.translate.instant('SYSTEM.CONNECTION_LOGS.TYPE') || 'Type',
        width: 80,
        cellStyle: { display: 'flex', justifyContent: 'center', alignItems: 'center', textAlign: 'center' },
        cellClass: 'type-column-cell',
        cellRenderer: (params: any) => {
          const type = params.value || 'login';
          const badgeClass = type === 'discussion' ? 'badge bg-info' : 'badge bg-primary';
          return `<span class="${badgeClass}">${type}</span>`;
        }
      },
      {
        field: 'member',
        headerName: this.translate.instant('SYSTEM.CONNECTION_LOGS.USER'),
        width: 200,
        valueGetter: (params) => {
          // Prefer memberUserName (from optimized backend), fallback to member.userName or memberId
          if (params.data?.memberUserName) {
            return params.data.memberUserName;
          }
          if (params.data?.member?.userName) {
            return params.data.member.userName;
          }
          if (params.data?.memberId) {
            return params.data.memberId; // Show ID if username not loaded yet
          }
          return 'N/A';
        }
      },
      {
        field: 'discussionTitle',
        headerName: this.translate.instant('SYSTEM.CONNECTION_LOGS.DISCUSSION_TITLE') || 'Discussion',
        width: 250,
        cellRenderer: (params: any) => {
          if (params.data?.type === 'discussion' && params.value) {
            return `<div><strong>${params.value}</strong></div>`;
          }
          return params.data?.type === 'discussion' ? '<em>No title</em>' : '-';
        }
      },
      {
        field: 'discussionId',
        headerName: this.translate.instant('SYSTEM.CONNECTION_LOGS.DISCUSSION_ID') || 'Discussion ID',
        width: 200,
        cellRenderer: (params: any) => {
          if (params.data?.type === 'discussion' && params.value) {
            return `<code style="font-size: 0.85em;">${params.value}</code>`;
          }
          return '-';
        }
      },
      {
        field: 'ipAddress',
        headerName: this.translate.instant('SYSTEM.CONNECTION_LOGS.IP_ADDRESS'),
        width: 150
      },
      {
        field: 'domainName',
        headerName: this.translate.instant('SYSTEM.CONNECTION_LOGS.DOMAIN_NAME'),
        width: 200
      },
      {
        field: 'location',
        headerName: this.translate.instant('SYSTEM.CONNECTION_LOGS.LOCATION'),
        width: 250,
        flex: 2
      }
    ];
  }


  loadCacheStats(): void {
    this.isLoadingStats = true;
    this.statsError = '';
    
    // Load backend cache stats
    this._cacheService.getCacheStats().subscribe(
      response => {
        let responseData = response;
        if (response._body) {
          responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
        }
        
        if (responseData.success) {
          this.cacheStats = responseData;
        } else {
          this.statsError = responseData.message || 'Failed to load cache statistics';
        }
        this.isLoadingStats = false;
      },
      error => {
        this.statsError = error.message || 'Error loading cache statistics';
        this.isLoadingStats = false;
      }
    );
    
    // Calculate frontend cache stats
    this.calculateFrontendCacheStats();
  }

  calculateFrontendCacheStats(): void {
    try {
      const stats: any = {
        localStorage: {
          enabled: typeof Storage !== 'undefined' && typeof localStorage !== 'undefined',
          entryCount: 0,
          totalSizeBytes: 0,
          totalSizeMB: 0
        },
        sessionStorage: {
          enabled: typeof Storage !== 'undefined' && typeof sessionStorage !== 'undefined',
          entryCount: 0,
          totalSizeBytes: 0,
          totalSizeMB: 0
        },
        memory: {
          available: false,
          usedJSHeapSize: 0,
          totalJSHeapSize: 0,
          jsHeapSizeLimit: 0
        },
        blobUrls: {
          estimatedCount: 0,
          note: 'Estimated from browser memory'
        }
      };

      // Calculate localStorage stats
      if (stats.localStorage.enabled) {
        try {
          let totalSize = 0;
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) {
              const value = localStorage.getItem(key);
              if (value !== null) {
                // Calculate actual byte size: key + value, each character is 2 bytes in UTF-16
                totalSize += (key.length + value.length) * 2;
                stats.localStorage.entryCount++;
              }
            }
          }
          stats.localStorage.totalSizeBytes = totalSize;
          stats.localStorage.totalSizeMB = (totalSize / (1024 * 1024));
          stats.localStorage.totalSizeKB = (totalSize / 1024);
        } catch (e) {
          console.warn('Error calculating localStorage stats:', e);
          stats.localStorage.error = (e instanceof Error ? e.message : String(e)) || 'Unknown error';
        }
      }

      // Calculate sessionStorage stats
      if (stats.sessionStorage.enabled) {
        try {
          let totalSize = 0;
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key) {
              const value = sessionStorage.getItem(key);
              if (value !== null) {
                // Calculate actual byte size: key + value, each character is 2 bytes in UTF-16
                totalSize += (key.length + value.length) * 2;
                stats.sessionStorage.entryCount++;
              }
            }
          }
          stats.sessionStorage.totalSizeBytes = totalSize;
          stats.sessionStorage.totalSizeMB = (totalSize / (1024 * 1024));
          stats.sessionStorage.totalSizeKB = (totalSize / 1024);
        } catch (e) {
          console.warn('Error calculating sessionStorage stats:', e);
          stats.sessionStorage.error = (e instanceof Error ? e.message : String(e)) || 'Unknown error';
        }
      }

      // Get memory stats if available (Chrome/Edge)
      if ((performance as any).memory) {
        const memory = (performance as any).memory;
        stats.memory.available = true;
        stats.memory.usedJSHeapSize = memory.usedJSHeapSize || 0;
        stats.memory.totalJSHeapSize = memory.totalJSHeapSize || 0;
        stats.memory.jsHeapSizeLimit = memory.jsHeapSizeLimit || 0;
      }

      // Estimate blob URLs (we can't directly count them, but we can note their existence)
      // This is an approximation based on typical usage
      stats.blobUrls.note = 'Blob URLs are managed by components and cleaned up automatically';

      this.frontendCacheStats = stats;
    } catch (error) {
      console.error('Error calculating frontend cache stats:', error);
      this.frontendCacheStats = {
        error: 'Unable to calculate frontend cache statistics'
      };
    }
  }

  saveCache(): void {
    if (!this.isSaveCacheAuthorized) {
      this.saveMessage = 'You are not authorized to save the cache.';
      this.saveMessageVisible = true;
      setTimeout(() => {
        this.saveMessageVisible = false;
        this.saveMessage = '';
      }, 5000);
      return;
    }
    
    this.isSaving = true;
    this.saveMessageVisible = false;
    this._cacheService.saveCache(this.user).subscribe(
      response => {
        console.log("Cache save response: " + JSON.stringify(response));
        let responseData = response;
        if (response._body) {
          responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
        }
        
        if (responseData.success) {
          const entryCount = responseData.entryCount || 0;
          const savedSizeMB = ((responseData.savedSizeBytes || 0) / (1024 * 1024)).toFixed(2);
          const fileSizeMB = ((responseData.fileSizeBytes || 0) / (1024 * 1024)).toFixed(2);
          this.saveMessage = `✅ Success: ${entryCount} entries saved (${savedSizeMB} MB, file: ${fileSizeMB} MB)`;
        } else {
          this.saveMessage = `❌ Failed: ${responseData.message || 'Unknown error'}`;
        }
        this.saveMessageVisible = true;
        this.isSaving = false;

        setTimeout(() => {
          this.saveMessageVisible = false;
          this.saveMessage = '';
        }, 10000);
      },
      error => {
        this.saveMessage = `❌ Error: ${error.message || 'Unknown error'}`;
        this.saveMessageVisible = true;
        this.isSaving = false;

        setTimeout(() => {
          this.saveMessageVisible = false;
          this.saveMessage = '';
        }, 10000);
      }
    );
  }

  loadCache(): void {
    if (!this.isLoadCacheAuthorized) {
      this.loadMessage = 'You are not authorized to load the cache.';
      this.loadMessageVisible = true;
      setTimeout(() => {
        this.loadMessageVisible = false;
        this.loadMessage = '';
      }, 5000);
      return;
    }
    
    this.isLoading = true;
    this.loadMessageVisible = false;
    
    // First check if cache file exists
    this._cacheService.cacheFileExists().subscribe(
      existsResponse => {
        let existsData = existsResponse;
        if (existsResponse._body) {
          existsData = typeof existsResponse._body === 'string' ? JSON.parse(existsResponse._body) : existsResponse._body;
        }
        
        if (!existsData.exists) {
          this.isLoading = false;
          this.loadMessage = `⚠️ Cache file does not exist. Please save the cache first.`;
          this.loadMessageVisible = true;
          setTimeout(() => {
            this.loadMessageVisible = false;
            this.loadMessage = '';
          }, 10000);
          return;
        }
        
        // File exists, proceed with loading
        this._cacheService.loadCache(this.user).subscribe(
          response => {
            console.log("Cache load response: " + JSON.stringify(response));
            let responseData = response;
            if (response._body) {
              responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
            }
            
            if (responseData.success) {
              const entryCount = responseData.entryCount || 0;
              const loadedSizeMB = ((responseData.loadedSizeBytes || 0) / (1024 * 1024)).toFixed(2);
              this.loadMessage = `✅ Success: ${entryCount} entries loaded (${loadedSizeMB} MB)`;
            } else {
              this.loadMessage = `⚠️ ${responseData.message || 'Failed to load cache'}`;
            }
            this.loadMessageVisible = true;
            this.isLoading = false;

            setTimeout(() => {
              this.loadMessageVisible = false;
              this.loadMessage = '';
            }, 10000);
          },
          error => {
            this.loadMessage = `❌ Error: ${error.message || 'Unknown error'}`;
            this.loadMessageVisible = true;
            this.isLoading = false;

            setTimeout(() => {
              this.loadMessageVisible = false;
              this.loadMessage = '';
            }, 10000);
          }
        );
      },
      error => {
        this.isLoading = false;
        this.loadMessage = `❌ Error checking cache file: ${error.message || 'Unknown error'}`;
        this.loadMessageVisible = true;
        setTimeout(() => {
          this.loadMessageVisible = false;
          this.loadMessage = '';
        }, 10000);
      }
    );
  }

  clearCache(): void {
    if (!this.isClearCacheAuthorized) {
      this.clearMessage = 'You are not authorized to clear the cache.';
      this.clearMessageVisible = true;
      setTimeout(() => {
        this.clearMessageVisible = false;
        this.clearMessage = '';
      }, 5000);
      return;
    }
    
    if (!confirm('Are you sure you want to clear the cache? This will remove all cached images from memory and the file system.')) {
      return;
    }

    this.isClearing = true;
    this.clearMessageVisible = false;
    this._cacheService.clearCache(this.user).subscribe(
      response => {
        console.log("Cache clear response: " + JSON.stringify(response));
        let responseData = response;
        if (response._body) {
          responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
        }
        
        if (responseData.success) {
          const memoryEntries = responseData.memoryEntries || 0;
          const fileDeleted = responseData.fileDeleted ? 'Yes' : 'No';
          this.clearMessage = `✅ Success: Cleared ${memoryEntries} entries from memory, file deleted: ${fileDeleted}`;
        } else {
          this.clearMessage = `❌ Failed: ${responseData.message || 'Unknown error'}`;
        }
        this.clearMessageVisible = true;
        this.isClearing = false;

        setTimeout(() => {
          this.clearMessageVisible = false;
          this.clearMessage = '';
        }, 10000);
      },
      error => {
        this.clearMessage = `❌ Error: ${error.message || 'Unknown error'}`;
        this.clearMessageVisible = true;
        this.isClearing = false;

        setTimeout(() => {
          this.clearMessageVisible = false;
          this.clearMessage = '';
        }, 10000);
      }
    );
  }

  shutdownApplication(): void {
    if (!this.isShutdownAuthorized) {
      this.shutdownMessage = 'You are not authorized to shutdown the application.';
      this.shutdownMessageVisible = true;
      setTimeout(() => {
        this.shutdownMessageVisible = false;
        this.shutdownMessage = '';
      }, 5000);
      return;
    }

    if (!confirm('Are you sure you want to shutdown the application? The cache will be saved first, then the application will shutdown.')) {
      return;
    }

    this.isShuttingDown = true;
    this.shutdownMessageVisible = false;
    this.shutdownMessage = 'Saving cache and shutting down...';
    this.shutdownMessageVisible = true;

    this._cacheService.shutdownApplication(this.user).subscribe(
      response => {
        console.log("Shutdown response: " + JSON.stringify(response));
        let responseData = response;
        if (response._body) {
          responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
        }
        
        if (responseData.success) {
          const cacheSaved = responseData.cacheSaved ? 'Yes' : 'No';
          const entryCount = responseData.cacheEntryCount || 0;
          this.shutdownMessage = `✅ Cache saved (${entryCount} entries). Application is shutting down...`;
          
          // Wait a bit then show a message that the app is shutting down
          setTimeout(() => {
            this.shutdownMessage = 'Application is shutting down. Please wait...';
            // After a few more seconds, the connection will be lost
            setTimeout(() => {
              this.shutdownMessage = 'Connection lost. Application has been shut down.';
            }, 3000);
          }, 2000);
        } else {
          this.shutdownMessage = `❌ Error: ${responseData.message || 'Failed to shutdown'}`;
          this.isShuttingDown = false;
        }
      },
      error => {
        // Check if it's an authorization error (403)
        let errorData = error.error || {};
        if (typeof error.error === 'string') {
          try {
            errorData = JSON.parse(error.error);
          } catch (e) {
            errorData = { message: error.error };
          }
        }
        
        if (error.status === 403 || errorData.authorized === false) {
          this.shutdownMessage = `❌ ${errorData.message || 'You are not authorized to shutdown the application'}`;
          this.isShuttingDown = false;
          this.isShutdownAuthorized = false;
        } else {
          // Even if there's an error, the shutdown might have been initiated
          this.shutdownMessage = `Application shutdown initiated. ${error.message || 'Connection may be lost soon.'}`;
          // Don't set isShuttingDown to false as the app might still be shutting down
          setTimeout(() => {
            this.shutdownMessage = 'Connection lost. Application may have been shut down.';
          }, 3000);
        }
      }
    );
  }

  // Exception Report methods
  sendExceptionReport() {
    this.isSendingReport = true;
    this.reportMessage = '';
    this.reportError = '';
    this.previewError = '';

    this.exceptionReportService.sendExceptionReport().subscribe({
      next: (response) => {
        this.isSendingReport = false;
        this.reportMessage = response || 'Exception report sent successfully';
        this.reportError = '';
      },
      error: (error) => {
        this.isSendingReport = false;
        this.reportError = error.error || error.message || 'Error sending exception report';
        this.reportMessage = '';
        console.error('Error sending exception report:', error);
      }
    });
  }

  viewExceptionReport() {
    this.isLoadingPreview = true;
    this.previewError = '';
    this.reportHtml = null;
    this.isPreviewVisible = false;

    this.exceptionReportService.getExceptionReportPreview().subscribe({
      next: (html) => {
        this.isLoadingPreview = false;
        this.reportHtml = this.sanitizer.bypassSecurityTrustHtml(html);
        this.isPreviewVisible = true;
      },
      error: (error) => {
        this.isLoadingPreview = false;
        this.previewError = error.error || error.message || 'Error retrieving exception report';
        console.error('Error retrieving exception report preview:', error);
        this.isPreviewVisible = false;
      }
    });
  }

  closePreview(): void {
    this.isPreviewVisible = false;
  }

  refreshReport(): void {
    this.isLoadingPreview = true;
    this.previewError = '';
    this.isPreviewVisible = true;

    this.exceptionReportService.getExceptionReportPreview().subscribe({
      next: (html) => {
        this.isLoadingPreview = false;
        this.reportHtml = this.sanitizer.bypassSecurityTrustHtml(html);
        this.isPreviewVisible = true;
      },
      error: (error) => {
        this.isLoadingPreview = false;
        this.previewError = error.error || error.message || 'Error retrieving exception report';
        console.error('Error refreshing exception report preview:', error);
      }
    });
  }

  refreshAllStats(): void {
    this.loadCacheStats();
    this.calculateFrontendCacheStats();
    this.collectPerformanceStats();
    this.loadAdditionalDebugInfo();
  }

  loadAdditionalDebugInfo(): void {
    this.isLoadingAdditionalStats = true;
    
    // Get file thumbnails cache count from ElementEvenementComponent (static method, always current)
    this.fileThumbnailsCacheCount = ElementEvenementComponent.getCachedThumbnailsCount();
    
    // Get pending thumbnail loads count from ElementEvenementComponent (static method, always current)
    this.pendingThumbnailLoadsCount = ElementEvenementComponent.getPendingFileThumbnailLoadsCount();
    
    // Load compression cache stats from backend
    this.loadCompressionCacheStats();
    
    // Load host memory (system RAM) from backend
    this.loadHostMemoryUsage();
    
    // Load JVM memory from backend
    this.loadJvmMemoryUsage();
    
    // Note: fileThumbnailsCacheCount and pendingThumbnailLoadsCount are from static methods
    // so they're always current, but we update them here for consistency
  }

  private loadCompressionCacheStats(): void {
    this.getCacheStatsFromBackend().subscribe({
      next: (cacheInfo: any) => {
        if (cacheInfo && !cacheInfo.error) {
          this.compressionCacheCount = typeof cacheInfo.entryCount === 'number' 
            ? cacheInfo.entryCount 
            : parseInt(cacheInfo.entryCount, 10) || 0;
          this.compressionCacheSizeMB = typeof cacheInfo.totalSizeMB === 'number' 
            ? cacheInfo.totalSizeMB 
            : parseFloat(cacheInfo.totalSizeMB) || 0;
        } else {
          this.compressionCacheCount = 0;
          this.compressionCacheSizeMB = 0;
        }
        this.isLoadingAdditionalStats = false;
      },
      error: (error) => {
        console.error('Error fetching compression cache stats:', error);
        this.compressionCacheCount = 0;
        this.compressionCacheSizeMB = 0;
        this.isLoadingAdditionalStats = false;
      }
    });
  }

  private loadHostMemoryUsage(): void {
    this.getSystemMemoryFromBackend().subscribe({
      next: (memoryInfo: any) => {
        if (memoryInfo && !memoryInfo.error) {
          const usedMB = memoryInfo.usedMB || 0;
          const totalMB = memoryInfo.totalMB || 0;
          const totalGB = memoryInfo.totalGB || 0;
          const usagePercent = memoryInfo.usagePercent || 0;
          
          this.hostMemoryUsagePercent = Math.round(usagePercent);
          
          // Format: "usedMB MB / totalMB MB (totalGB GB) - usagePercent%"
          if (totalGB > 0) {
            this.hostMemoryUsage = `${usedMB} MB / ${totalMB} MB (${totalGB} GB) - ${Math.round(usagePercent)}%`;
          } else {
            this.hostMemoryUsage = `${usedMB} MB / ${totalMB} MB - ${Math.round(usagePercent)}%`;
          }
        } else {
          this.hostMemoryUsage = 'N/A';
          this.hostMemoryUsagePercent = 0;
        }
      },
      error: (error) => {
        console.error('Error fetching host memory:', error);
        this.hostMemoryUsage = 'N/A';
        this.hostMemoryUsagePercent = 0;
      }
    });
  }

  private loadJvmMemoryUsage(): void {
    this.getJvmMemoryFromBackend().subscribe({
      next: (memoryInfo: any) => {
        if (memoryInfo && !memoryInfo.error) {
          const usedMB = memoryInfo.usedMB || 0;
          const maxMB = memoryInfo.maxMB || 0;
          const freeMB = memoryInfo.freeMB || 0;
          const usagePercent = memoryInfo.usagePercent || 0;
          const status = memoryInfo.status || 'OK';
          
          this.jvmMemoryUsagePercent = Math.round(usagePercent);
          this.jvmStatus = status;
          
          // Format: "usedMB MB / maxMB MB (usagePercent%) - status"
          this.jvmMemoryUsage = `${usedMB} MB / ${maxMB} MB (${Math.round(usagePercent)}%) - ${status}`;
        } else {
          this.jvmMemoryUsage = 'N/A';
          this.jvmMemoryUsagePercent = 0;
          this.jvmStatus = 'UNKNOWN';
        }
      },
      error: (error) => {
        console.error('Error fetching JVM memory:', error);
        this.jvmMemoryUsage = 'N/A';
        this.jvmMemoryUsagePercent = 0;
        this.jvmStatus = 'ERROR';
      }
    });
  }

  private getCacheStatsFromBackend(): Observable<any> {
    return from(this._keycloakService.getToken()).pipe(
      switchMap((token: string) => {
        const headers = new HttpHeaders({
          'Accept': 'application/json',
          'Content-Type': 'application/json; charset=UTF-8',
          'Authorization': 'Bearer ' + token
        });
        return this._http.get<any>(environment.API_URL + 'system/cache', { headers: headers });
      }),
      catchError((error) => {
        return of({ error: error.message || 'Failed to retrieve cache statistics' });
      })
    );
  }

  private getSystemMemoryFromBackend(): Observable<any> {
    return from(this._keycloakService.getToken()).pipe(
      switchMap((token: string) => {
        const headers = new HttpHeaders({
          'Accept': 'application/json',
          'Content-Type': 'application/json; charset=UTF-8',
          'Authorization': 'Bearer ' + token
        });
        return this._http.get<any>(environment.API_URL + 'system/memory', { headers: headers });
      }),
      catchError((error) => {
        return of({ error: error.message || 'Failed to retrieve system memory' });
      })
    );
  }

  private getJvmMemoryFromBackend(): Observable<any> {
    return from(this._keycloakService.getToken()).pipe(
      switchMap((token: string) => {
        const headers = new HttpHeaders({
          'Accept': 'application/json',
          'Content-Type': 'application/json; charset=UTF-8',
          'Authorization': 'Bearer ' + token
        });
        return this._http.get<any>(environment.API_URL + 'system/memory', { headers: headers });
      }),
      catchError((error) => {
        return of({ error: error.message || 'Failed to retrieve JVM memory' });
      })
    );
  }

  collectPerformanceStats(): void {
    try {
      const stats: any = {
        pageLoadTime: 0,
        domReadyTime: 0,
        connectionType: 'N/A',
        screenResolution: 'N/A',
        userAgent: 'N/A',
        language: 'N/A'
      };

      // Calculate page load time
      if (this.pageLoadStartTime > 0) {
        stats.pageLoadTime = performance.now() - this.pageLoadStartTime;
      }

      // Get DOM ready time from performance timing
      if (performance.timing) {
        const timing = performance.timing;
        if (timing.domContentLoadedEventEnd > 0 && timing.navigationStart > 0) {
          stats.domReadyTime = timing.domContentLoadedEventEnd - timing.navigationStart;
        }
      }

      // Get connection type (if available)
      if ((navigator as any).connection) {
        const connection = (navigator as any).connection;
        stats.connectionType = connection.effectiveType || connection.type || 'N/A';
      }

      // Get screen resolution
      if (window.screen) {
        stats.screenResolution = `${window.screen.width}x${window.screen.height}`;
      }

      // Get user agent
      if (navigator.userAgent) {
        // Truncate user agent if too long
        const ua = navigator.userAgent;
        stats.userAgent = ua.length > 80 ? ua.substring(0, 80) + '...' : ua;
      }

      // Get language
      if (navigator.language) {
        stats.language = navigator.language;
      }

      this.performanceStats = stats;
    } catch (error) {
      console.error('Error collecting performance stats:', error);
      this.performanceStats = {
        error: 'Unable to collect performance statistics'
      };
    }
  }

  formatTime(ms: number): string {
    if (ms < 1000) {
      return `${ms.toFixed(2)} ms`;
    } else {
      return `${(ms / 1000).toFixed(2)} s`;
    }
  }

  viewConnectionLogs(): void {
    this.isConnectionLogsVisible = true;
    // Ensure columns are initialized before loading data
    if (this.connectionLogsColumnDefs.length === 0) {
      this.initializeConnectionLogsColumns();
    }
    this.loadConnectionLogs();
  }

  closeConnectionLogs(): void {
    this.isConnectionLogsVisible = false;
    this.connectionLogs = [];
    this.connectionLogsError = '';
  }

  loadConnectionLogs(): void {
    this.isLoadingConnectionLogs = true;
    this.connectionLogsError = '';
    const t0 = performance.now();
    
    // Performance: load only first page (100 rows) without usernames for instant load
    // Usernames can be loaded on demand if needed (set includeUsernames=true)
    const page = 0;
    const size = 100;
    const includeUsernames = true; // Show username in "Utilisateur" column

    this._cacheService.getConnectionLogs(this.connectionLogsStartDate, this.connectionLogsEndDate, page, size, includeUsernames).subscribe(
      (response: any) => {
        const tResp = performance.now();
        let responseData = response;
        // Handle different response formats
        if (response && typeof response === 'object' && '_body' in response) {
          responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
        } else if (response && typeof response === 'object') {
          responseData = response;
        }
        
        if (responseData && responseData.success !== false) {
          this.connectionLogs = responseData.logs || [];
          this.connectionLogsCount = responseData.count || this.connectionLogs.length;
          
          console.log('Connection logs loaded:', this.connectionLogs.length, 'logs', `(${Math.round(tResp - t0)}ms)`);
          console.log('Column definitions:', this.connectionLogsColumnDefs.length);
          
          // Convert date strings to Date objects
          this.connectionLogs = this.connectionLogs.map((log: any) => {
            if (log.connectionDate && typeof log.connectionDate === 'string') {
              log.connectionDate = new Date(log.connectionDate);
            }
            return log;
          });
          
          // Update column headers with translations
          this.updateColumnHeaders();
        } else {
          this.connectionLogsError = responseData.error || 'Failed to load connection logs';
          this.connectionLogs = [];
        }
        this.isLoadingConnectionLogs = false;
      },
      error => {
        console.log(`Connection logs request failed after ${Math.round(performance.now() - t0)}ms`, error);
        this.connectionLogsError = error.error?.error || error.message || 'Error loading connection logs';
        this.connectionLogs = [];
        this.isLoadingConnectionLogs = false;
      }
    );
  }
  
  updateColumnHeaders(): void {
    this.connectionLogsColumnDefs.forEach(col => {
      if (col.field === 'connectionDate') {
        col.headerName = this.translate.instant('SYSTEM.CONNECTION_LOGS.DATE_TIME');
      } else if (col.field === 'type') {
        col.headerName = this.translate.instant('SYSTEM.CONNECTION_LOGS.TYPE') || 'Type';
      } else if (col.field === 'member') {
        col.headerName = this.translate.instant('SYSTEM.CONNECTION_LOGS.USER');
      } else if (col.field === 'discussionTitle') {
        col.headerName = this.translate.instant('SYSTEM.CONNECTION_LOGS.DISCUSSION_TITLE') || 'Discussion';
      } else if (col.field === 'discussionId') {
        col.headerName = this.translate.instant('SYSTEM.CONNECTION_LOGS.DISCUSSION_ID') || 'Discussion ID';
      } else if (col.field === 'ipAddress') {
        col.headerName = this.translate.instant('SYSTEM.CONNECTION_LOGS.IP_ADDRESS');
      } else if (col.field === 'domainName') {
        col.headerName = this.translate.instant('SYSTEM.CONNECTION_LOGS.DOMAIN_NAME');
      } else if (col.field === 'location') {
        col.headerName = this.translate.instant('SYSTEM.CONNECTION_LOGS.LOCATION');
      }
    });
  }
  
  onGridReady(event: GridReadyEvent): void {
    if (event.api) {
      // Auto-size columns to fit
      setTimeout(() => {
        event.api.sizeColumnsToFit();
      }, 100);
    }
  }

  applyConnectionLogsFilter(): void {
    this.loadConnectionLogs();
  }

  formatConnectionDate(date: Date | string | undefined): string {
    if (!date) return 'N/A';
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleString();
  }

  getDateTimeLocalString(date: Date): string {
    if (!date) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  onStartDateChange(event: any): void {
    const value = event.target.value;
    if (value) {
      this.connectionLogsStartDate = new Date(value);
    }
  }

  onEndDateChange(event: any): void {
    const value = event.target.value;
    if (value) {
      this.connectionLogsEndDate = new Date(value);
    }
  }

  loadActiveDiscussionConnections(): void {
    this.isLoadingActiveConnections = true;
    this.activeConnectionsError = '';
    
    this.discussionService.getActiveConnections().subscribe({
      next: (connections) => {
        this.activeDiscussionConnections = connections || [];
        this.activeConnectionsCount = this.activeDiscussionConnections.length;
        this.isLoadingActiveConnections = false;
      },
      error: (error) => {
        this.activeConnectionsError = error.error?.error || error.message || 'Error loading active connections';
        this.activeDiscussionConnections = [];
        this.activeConnectionsCount = 0;
        this.isLoadingActiveConnections = false;
      }
    });
  }

  formatConnectionDateTime(dateTime: string | Date): string {
    if (!dateTime) return 'N/A';
    const d = typeof dateTime === 'string' ? new Date(dateTime) : dateTime;
    return d.toLocaleString();
  }

  deleteAllConnectionLogs(): void {
    if (!this.isDeleteConnectionLogsAuthorized) {
      this.deleteConnectionLogsMessage = this.translate.instant('SYSTEM.CONNECTION_LOGS.NOT_AUTHORIZED') || 'You are not authorized to delete connection logs.';
      this.deleteConnectionLogsMessageVisible = true;
      setTimeout(() => {
        this.deleteConnectionLogsMessageVisible = false;
        this.deleteConnectionLogsMessage = '';
      }, 5000);
      return;
    }
    
    if (!confirm(this.translate.instant('SYSTEM.CONNECTION_LOGS.DELETE_CONFIRM') || 'Are you sure you want to delete all connection logs? This action cannot be undone.')) {
      return;
    }

    this.isDeletingConnectionLogs = true;
    this.deleteConnectionLogsMessageVisible = false;
    this.deleteConnectionLogsMessage = '';

    this._cacheService.deleteAllConnectionLogs(this.user).subscribe({
      next: (response: any) => {
        let responseData = response;
        if (response && typeof response === 'object' && '_body' in response) {
          responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
        } else if (response && typeof response === 'object') {
          responseData = response;
        }

        this.isDeletingConnectionLogs = false;

        if (responseData && responseData.success) {
          const deletedCount = responseData.deletedCount || 0;
          const successMessage = this.translate.instant('SYSTEM.CONNECTION_LOGS.DELETE_SUCCESS') || 'Successfully deleted {count} connection log(s)';
          this.deleteConnectionLogsMessage = successMessage.replace('{count}', deletedCount.toString());
          this.deleteConnectionLogsMessageVisible = true;
          
          // Reload the connection logs to show empty state
          this.loadConnectionLogs();
          
          setTimeout(() => {
            this.deleteConnectionLogsMessageVisible = false;
            this.deleteConnectionLogsMessage = '';
          }, 5000);
        } else {
          this.deleteConnectionLogsMessage = responseData.error || this.translate.instant('SYSTEM.CONNECTION_LOGS.DELETE_ERROR') || 'Failed to delete connection logs';
          this.deleteConnectionLogsMessageVisible = true;
          
          setTimeout(() => {
            this.deleteConnectionLogsMessageVisible = false;
            this.deleteConnectionLogsMessage = '';
          }, 5000);
        }
      },
      error: (error) => {
        this.isDeletingConnectionLogs = false;
        this.deleteConnectionLogsMessage = error.error?.error || error.message || this.translate.instant('SYSTEM.CONNECTION_LOGS.DELETE_ERROR') || 'Error deleting connection logs';
        this.deleteConnectionLogsMessageVisible = true;
        
        setTimeout(() => {
          this.deleteConnectionLogsMessageVisible = false;
          this.deleteConnectionLogsMessage = '';
        }, 5000);
      }
    });
  }
}

