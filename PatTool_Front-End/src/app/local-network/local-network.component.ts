import { Component, OnInit, OnDestroy, ChangeDetectorRef, NgZone, TemplateRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModal, NgbModalRef, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { KeycloakService } from '../keycloak/keycloak.service';
import { LocalNetworkService } from '../services/local-network.service';

export interface NetworkDevice {
  ipAddress: string;
  hostname?: string;
  macAddress?: string;
  vendor?: string;
  os?: string;
  deviceType?: string;
  openPorts?: number[];
  services?: { [port: number]: ServiceInfo };
  vulnerabilities?: Vulnerability[];
  status: 'online' | 'offline' | 'unknown';
  lastSeen?: Date;
  webInterface?: boolean;
  webUrl?: string;
  databaseServer?: string;
  fileSharing?: boolean;
  remoteAccess?: string;
  sshAvailable?: boolean;
}

export interface ServiceInfo {
  port: number;
  service: string;
  status: string;
  banner?: string;
  version?: string;
  server?: string;
  poweredBy?: string;
  contentType?: string;
}

export interface Vulnerability {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  description: string;
  port?: number;
  service?: string;
}

@Component({
  selector: 'app-local-network',
  templateUrl: './local-network.component.html',
  styleUrls: ['./local-network.component.css'],
  standalone: true,
  imports: [CommonModule, TranslateModule, NavigationButtonsModule, NgbModule]
})
export class LocalNetworkComponent implements OnInit, OnDestroy {

  devices: NetworkDevice[] = [];
  isLoading: boolean = false;
  isScanning: boolean = false;
  scanProgress: number = 0;
  scanProgressText: string = '0%';
  scannedIps: number = 0;
  totalIps: number = 254;
  errorMessage: string = '';
  lastScanTime: Date | null = null;
  scanStartTime: Date | null = null;
  private scanSubscription: any = null;

  // Device mappings modal
  @ViewChild('deviceMappingsModal') deviceMappingsModal!: TemplateRef<any>;
  deviceMappings: any[] = [];
  sortedDeviceMappings: any[] = [];
  isLoadingMappings: boolean = false;
  isReloadingMappings: boolean = false;
  mappingsError: string = '';
  mappingsInfo: string = '';
  sortColumn: string = '';
  sortDirection: 'asc' | 'desc' = 'asc';
  private modalRef?: NgbModalRef;

  constructor(
    private router: Router,
    public keycloakService: KeycloakService,
    private localNetworkService: LocalNetworkService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private modalService: NgbModal
  ) { }

  ngOnInit() {
    // Check if user has admin role
    if (!this.keycloakService.hasAdminRole()) {
      this.router.navigate(['/']);
      return;
    }
  }

  startScan(): void {
    if (this.isScanning) {
      return;
    }

    // Cancel any existing subscription
    if (this.scanSubscription) {
      this.scanSubscription.unsubscribe();
      this.scanSubscription = null;
    }

    // Reset all scan state
    this.isScanning = true;
    this.isLoading = true;
    this.scanProgress = 0;
    this.scanProgressText = '0%';
    this.scannedIps = 0;
    this.totalIps = 254;
    this.errorMessage = '';
    this.devices = []; // Clear all previous devices
    this.scanStartTime = new Date();
    this.lastScanTime = null;

    // Force UI update
    this.cdr.detectChanges();

    // Use streaming scan for real-time updates
    this.scanSubscription = this.localNetworkService.scanNetworkStream().subscribe({
      next: (event) => {
        // Run in Angular zone to ensure change detection
        this.ngZone.run(() => {
          this.handleScanEvent(event);
        });
      },
      error: (error) => {
        this.ngZone.run(() => {
          this.handleScanError(error);
        });
      },
      complete: () => {
        this.ngZone.run(() => {
          this.handleScanComplete();
        });
        // Clear subscription reference
        this.scanSubscription = null;
      }
    });
  }

  ngOnDestroy(): void {
    // Clean up subscription on component destroy
    if (this.scanSubscription) {
      this.scanSubscription.unsubscribe();
      this.scanSubscription = null;
    }
  }

  private handleScanEvent(event: any): void {
    switch (event.type) {
      case 'scan-started':
        this.isScanning = true;
        this.isLoading = true;
        this.scanProgress = 0;
        this.scanProgressText = '0%';
        this.scannedIps = 0;
        this.scanStartTime = new Date();
        break;

      case 'device-found':
        // Update progress immediately
        if (event.data.progress !== undefined && event.data.total !== undefined) {
          this.scannedIps = event.data.progress;
          this.totalIps = event.data.total;
          const progressPercent = Math.min(99, Math.round((this.scannedIps / this.totalIps) * 100));
          this.scanProgress = progressPercent;
          this.scanProgressText = `${progressPercent}% (${this.scannedIps}/${this.totalIps})`;
        }

        // Add device to list immediately
        const deviceData = event.data?.device;
        if (deviceData) {
          this.addOrUpdateDevice(deviceData);
          // Force change detection to update UI immediately
          this.cdr.detectChanges();
        }
        break;

      case 'scan-completed':
        // Ensure we show 100% completion
        this.scanProgress = 100;
        this.scanProgressText = `100% (${this.totalIps}/${this.totalIps})`;
        this.scannedIps = this.totalIps;
        
        // Wait a moment before hiding progress bar
        setTimeout(() => {
          this.isLoading = false;
          this.isScanning = false;
          this.lastScanTime = new Date();
          
          // Keep progress bar visible for 2 seconds after completion
          setTimeout(() => {
            if (!this.isScanning) {
              this.scanProgress = 0;
              this.scanProgressText = '0%';
            }
          }, 2000);
        }, 500);
        break;

      case 'error':
        this.isLoading = false;
        this.isScanning = false;
        this.scanProgress = 0;
        this.scanProgressText = '0%';
        this.errorMessage = event.data?.message || event.data?.error || 'Error during network scan';
        console.error('Error during network scan:', event.data);
        break;
    }
  }

  private addOrUpdateDevice(deviceData: any): void {
    if (!deviceData) {
      return;
    }

    const device: NetworkDevice = {
      ipAddress: deviceData.ipAddress || deviceData.ip,
      hostname: deviceData.hostname || deviceData.host_name || null,
      macAddress: deviceData.macAddress || deviceData.mac,
      vendor: deviceData.vendor,
      os: deviceData.os || deviceData.operatingSystem,
      deviceType: deviceData.deviceType || deviceData.device_type || 'Unknown Device',
      openPorts: deviceData.openPorts || [],
      services: deviceData.services || {},
      vulnerabilities: deviceData.vulnerabilities || [],
      status: deviceData.status || 'online',
      lastSeen: deviceData.lastSeen ? new Date(deviceData.lastSeen) : new Date(),
      webInterface: deviceData.webInterface,
      webUrl: deviceData.webUrl,
      databaseServer: deviceData.databaseServer,
      fileSharing: deviceData.fileSharing,
      remoteAccess: deviceData.remoteAccess,
      sshAvailable: deviceData.sshAvailable
    };
    
    if (!device.ipAddress) {
      console.error('[Component] Device has no IP address:', deviceData);
      return;
    }
    
    // Check if device already exists (by IP) to avoid duplicates
    const existingIndex = this.devices.findIndex(d => d.ipAddress === device.ipAddress);
    if (existingIndex >= 0) {
      this.devices[existingIndex] = device; // Update existing
    } else {
      // Create new array reference to trigger change detection
      this.devices = [...this.devices, device];
    }
    
    // Force change detection after adding/updating device
    this.cdr.markForCheck();
  }

  private handleScanError(error: any): void {
    this.isLoading = false;
    this.isScanning = false;
    this.scanProgress = 0;
    this.scanProgressText = '0%';
    this.errorMessage = error.error?.message || error.message || 'Erreur lors du scan du réseau';
    console.error('Network scan error:', error);
  }

  private handleScanComplete(): void {
    // Only update if scan wasn't already marked as completed
    if (this.isScanning) {
      // If we reach here without scan-completed event, mark as complete
      this.scanProgress = 100;
      this.scanProgressText = `100% (${this.totalIps}/${this.totalIps})`;
      
      setTimeout(() => {
        this.isScanning = false;
        this.isLoading = false;
        this.lastScanTime = new Date();
        
        setTimeout(() => {
          if (!this.isScanning) {
            this.scanProgress = 0;
            this.scanProgressText = '0%';
          }
        }, 2000);
      }, 500);
    }
  }

  getSeverityClass(severity: string): string {
    switch (severity.toLowerCase()) {
      case 'critical':
        return 'badge-danger';
      case 'high':
        return 'badge-warning';
      case 'medium':
        return 'badge-info';
      case 'low':
        return 'badge-secondary';
      default:
        return 'badge-light';
    }
  }

  getTotalVulnerabilities(): number {
    return this.devices.reduce((total, device) => {
      return total + (device.vulnerabilities?.length || 0);
    }, 0);
  }

  getCriticalVulnerabilities(): number {
    return this.devices.reduce((total, device) => {
      return total + (device.vulnerabilities?.filter(v => v.severity === 'critical').length || 0);
    }, 0);
  }

  getHighVulnerabilities(): number {
    return this.devices.reduce((total, device) => {
      return total + (device.vulnerabilities?.filter(v => v.severity === 'high').length || 0);
    }, 0);
  }

  /**
   * Open device URL in a new tab
   */
  openDeviceUrl(device: NetworkDevice): void {
    const url = `http://${device.ipAddress}`;
    window.open(url, '_blank');
  }

  /**
   * Open router interface in browser
   */
  openRouterInterface(): void {
    const routerUrl = 'http://192.168.1.1/start.htm';
    window.open(routerUrl, '_blank');
  }

  /**
   * Get device display name (hostname or IP)
   */
  getDeviceName(device: NetworkDevice): string {
    return device.hostname || device.ipAddress;
  }

  /**
   * Get device display name for header (prefer hostname, fallback to IP)
   */
  getDeviceDisplayName(device: NetworkDevice): string {
    // Always prefer hostname if it exists and is different from IP
    if (device.hostname && device.hostname.trim() !== '' && device.hostname !== device.ipAddress) {
      return device.hostname.trim();
    }
    return device.ipAddress;
  }

  /**
   * Check if hostname should be shown as subtitle (only if different from displayed name)
   */
  shouldShowHostnameSubtitle(device: NetworkDevice): boolean {
    if (!device.hostname || device.hostname === device.ipAddress) {
      return false;
    }
    // Don't show if hostname is already displayed as the main name
    const displayedName = this.getDeviceDisplayName(device);
    return device.hostname !== displayedName && !device.hostname.startsWith(displayedName);
  }

  /**
   * Get icon based on device type
   */
  getDeviceIcon(device: NetworkDevice): string {
    if (!device.deviceType) {
      return 'fa-desktop';
    }
    
    const type = device.deviceType.toLowerCase();
    if (type.includes('router') || type.includes('gateway')) {
      return 'fa-wifi';
    } else if (type.includes('server')) {
      return 'fa-server';
    } else if (type.includes('nas') || type.includes('storage')) {
      return 'fa-hdd-o';
    } else if (type.includes('printer')) {
      return 'fa-print';
    } else if (type.includes('iot')) {
      return 'fa-microchip';
    } else if (type.includes('windows')) {
      return 'fa-windows';
    } else if (type.includes('linux') || type.includes('unix')) {
      return 'fa-linux';
    } else {
      return 'fa-desktop';
    }
  }

  /**
   * Convert services object to array for template
   */
  getServicesArray(services: { [port: number]: ServiceInfo } | undefined): ServiceInfo[] {
    if (!services) return [];
    return Object.values(services).sort((a, b) => a.port - b.port);
  }

  /**
   * Check if services object has keys
   */
  hasServices(services: { [port: number]: ServiceInfo } | undefined): boolean {
    if (!services) return false;
    return Object.keys(services).length > 0;
  }

  /**
   * Get header CSS class based on vulnerabilities
   * High vulnerability → red, Low vulnerability → orange, No vulnerability → green
   */
  getDeviceHeaderClass(device: NetworkDevice): string {
    if (!device.vulnerabilities || device.vulnerabilities.length === 0) {
      return 'device-header-safe'; // Green (default)
    }
    
    // Check for high severity vulnerabilities
    const hasHigh = device.vulnerabilities.some(v => 
      v.severity === 'high' || v.severity === 'critical'
    );
    
    if (hasHigh) {
      return 'device-header-danger'; // Red
    }
    
    // Check for low severity vulnerabilities
    const hasLow = device.vulnerabilities.some(v => 
      v.severity === 'low' || v.severity === 'medium'
    );
    
    if (hasLow) {
      return 'device-header-warning'; // Orange
    }
    
    return 'device-header-safe'; // Green (default)
  }

  /**
   * Open device mappings modal and load data from MongoDB
   */
  openDeviceMappingsModal(): void {
    this.isLoadingMappings = true;
    this.deviceMappings = [];
    this.mappingsError = '';
    this.mappingsInfo = '';
    
    this.modalRef = this.modalService.open(this.deviceMappingsModal, {
      size: 'xl',
      windowClass: 'slideshow-modal-wide',
      backdrop: 'static',
      keyboard: true
    });

    this.loadDeviceMappings();
  }

  loadDeviceMappings(): void {
    this.isLoadingMappings = true;
    this.mappingsError = '';
    this.mappingsInfo = '';
    
    this.localNetworkService.getDeviceMappings().subscribe({
      next: (response) => {
        if (response && response.devices) {
          this.deviceMappings = response.devices;
          this.mappingsError = '';
          if (this.deviceMappings.length === 0) {
            this.mappingsInfo = 'La collection MongoDB est vide. Cliquez sur "Recharger depuis CSV" pour charger les données.';
          }
        } else if (response && Array.isArray(response)) {
          // Handle case where response is directly an array
          this.deviceMappings = response;
          this.mappingsError = '';
          if (this.deviceMappings.length === 0) {
            this.mappingsInfo = 'La collection MongoDB est vide. Cliquez sur "Recharger depuis CSV" pour charger les données.';
          }
        } else {
          this.deviceMappings = [];
          this.mappingsInfo = 'Aucune donnée trouvée dans la réponse. La collection MongoDB est peut-être vide.';
        }
        
        // Initialize sorted array - sort by device name by default
        this.sortColumn = 'deviceName';
        this.sortDirection = 'asc';
        this.sortedDeviceMappings = [...this.deviceMappings].sort((a, b) => {
          const aValue = (a.deviceName || '').toLowerCase();
          const bValue = (b.deviceName || '').toLowerCase();
          if (aValue < bValue) return -1;
          if (aValue > bValue) return 1;
          return 0;
        });
        
        this.isLoadingMappings = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error('[Component] Error loading device mappings:', error);
        this.isLoadingMappings = false;
        this.deviceMappings = [];
        
        if (error?.status === 403) {
          this.mappingsError = 'Accès refusé. Vous devez avoir le rôle administrateur.';
        } else if (error?.status === 404) {
          this.mappingsError = 'Endpoint non trouvé. Vérifiez la configuration du backend.';
        } else if (error?.error?.message) {
          this.mappingsError = `Erreur: ${error.error.message}`;
        } else {
          this.mappingsError = `Erreur lors du chargement: ${error?.message || 'Erreur inconnue'}`;
        }
        
        this.cdr.detectChanges();
      }
    });
  }

  reloadDeviceMappings(): void {
    // Use setTimeout to avoid ExpressionChangedAfterItHasBeenCheckedError
    setTimeout(() => {
      this.ngZone.run(() => {
        this.isReloadingMappings = true;
        this.mappingsError = '';
        this.mappingsInfo = 'Rechargement en cours depuis le fichier CSV...';
        this.cdr.detectChanges();
      });
    }, 0);
    
    this.localNetworkService.reloadDeviceMappings().subscribe({
      next: (response) => {
        this.ngZone.run(() => {
          this.mappingsInfo = `Rechargement terminé. ${response.afterCount || 0} mappings chargés.`;
          this.isReloadingMappings = false;
          this.cdr.detectChanges();
          
          // Reload the mappings after reload
          setTimeout(() => {
            this.ngZone.run(() => {
              this.loadDeviceMappings();
            });
          }, 500);
        });
      },
      error: (error) => {
        console.error('[Component] Error reloading device mappings:', error);
        this.ngZone.run(() => {
          this.isReloadingMappings = false;
          this.mappingsInfo = '';
          
          if (error?.error?.message) {
            this.mappingsError = `Erreur lors du rechargement: ${error.error.message}`;
          } else {
            this.mappingsError = `Erreur lors du rechargement: ${error?.message || 'Erreur inconnue'}`;
          }
          
          this.cdr.detectChanges();
        });
      }
    });
  }

  /**
   * Close device mappings modal
   */
  closeDeviceMappingsModal(): void {
    if (this.modalRef) {
      this.modalRef.close();
      this.modalRef = undefined;
    }
  }

  /**
   * Sort device mappings by column
   */
  sortMappings(column: string): void {
    if (this.sortColumn === column) {
      // Toggle direction if same column
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      // New column, start with ascending
      this.sortColumn = column;
      this.sortDirection = 'asc';
    }

    this.sortedDeviceMappings = [...this.deviceMappings].sort((a, b) => {
      let aValue: any;
      let bValue: any;

      if (column === 'ipAddress') {
        aValue = a.ipAddress || '';
        bValue = b.ipAddress || '';
        // Sort IP addresses numerically
        const aParts = aValue.split('.').map((p: string) => parseInt(p, 10));
        const bParts = bValue.split('.').map((p: string) => parseInt(p, 10));
        for (let i = 0; i < 4; i++) {
          const aPart = aParts[i] || 0;
          const bPart = bParts[i] || 0;
          if (aPart !== bPart) {
            return this.sortDirection === 'asc' ? aPart - bPart : bPart - aPart;
          }
        }
        return 0;
      } else if (column === 'deviceName') {
        aValue = (a.deviceName || '').toLowerCase();
        bValue = (b.deviceName || '').toLowerCase();
      } else if (column === 'macAddress') {
        aValue = (a.macAddress || '').toLowerCase();
        bValue = (b.macAddress || '').toLowerCase();
      } else if (column === 'deviceNumber') {
        aValue = a.deviceNumber || 0;
        bValue = b.deviceNumber || 0;
      } else {
        return 0;
      }

      if (aValue < bValue) {
        return this.sortDirection === 'asc' ? -1 : 1;
      } else if (aValue > bValue) {
        return this.sortDirection === 'asc' ? 1 : -1;
      }
      return 0;
    });

    this.cdr.detectChanges();
  }

  /**
   * Get sort icon for column header
   */
  getSortIcon(column: string): string {
    if (this.sortColumn !== column) {
      return 'fa-sort';
    }
    return this.sortDirection === 'asc' ? 'fa-sort-up' : 'fa-sort-down';
  }
}

