import { Component, OnInit, OnDestroy, ChangeDetectorRef, NgZone, TemplateRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
  macAddressSource?: 'mongodb' | 'arp' | 'local';
  macAddressARP?: string;
  macAddressMongoDB?: string;
  macAddressConflict?: boolean;
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
  imports: [CommonModule, FormsModule, TranslateModule, NavigationButtonsModule, NgbModule]
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
  isAuthorized: boolean = false; // Prevent template rendering until authorization is verified

  // Device sorting - Default: sort by vulnerabilities (most vulnerable first)
  deviceSortBy: 'ip' | 'name' | 'type' | 'vulnerabilities' | 'status' = 'vulnerabilities';
  deviceSortDirection: 'asc' | 'desc' = 'desc'; // Descending by default for vulnerabilities (most vulnerable first)
  
  // Device filter - Filter by name (hostname), IP address, MAC address, and vendor
  deviceFilter: string = '';
  
  // OUI input for vendor lookup
  ouiInput: string = '';
  
  // External API for vendor detection (OUI lookup)
  useExternalVendorAPI: boolean = false; // Default: false (use local database)

  // Network scan scheduler enabled flag
  scanSchedulerEnabled: boolean = false; // Default: false
  isLoadingSchedulerStatus: boolean = false;

  // Device mappings modal
  @ViewChild('deviceMappingsModal') deviceMappingsModal!: TemplateRef<any>;
  deviceMappings: any[] = [];
  sortedDeviceMappings: any[] = [];
  isLoadingMappings: boolean = false;
  mappingsError: string = '';
  mappingsInfo: string = '';
  sortColumn: string = '';
  sortDirection: 'asc' | 'desc' = 'asc';
  private modalRef?: NgbModalRef;

  // Vendor info modal
  @ViewChild('vendorInfoModal') vendorInfoModal!: TemplateRef<any>;
  vendorInfo: any = null;
  isLoadingVendorInfo: boolean = false;
  vendorInfoError: string = '';
  private vendorInfoModalRef?: NgbModalRef;

  // MAC Vendor Mappings modal
  @ViewChild('macVendorMappingsModal') macVendorMappingsModal!: TemplateRef<any>;
  macVendorMappings: any[] = [];
  sortedMacVendorMappings: any[] = [];
  isLoadingMacVendorMappings: boolean = false;
  macVendorMappingsError: string = '';
  macVendorMappingsInfo: string = '';
  macVendorSortColumn: string = '';
  macVendorSortDirection: 'asc' | 'desc' = 'asc';
  private macVendorMappingsModalRef?: NgbModalRef;

  // MAC Vendor mapping form
  editingMacVendorMapping: any = null;
  showMacVendorMappingForm: boolean = false;
  macVendorMappingForm: {
    oui: string;
    vendor: string;
  } = {
    oui: '',
    vendor: ''
  };
  isSavingMacVendorMapping: boolean = false;

  // Device mapping form
  editingMapping: any = null;
  showMappingForm: boolean = false;
  mappingForm: {
    ipAddress: string;
    deviceName: string;
    macAddress: string;
    deviceNumber: number | null;
  } = {
    ipAddress: '',
    deviceName: '',
    macAddress: '',
    deviceNumber: null
  };
  isSavingMapping: boolean = false;

  constructor(
    private router: Router,
    public keycloakService: KeycloakService,
    private localNetworkService: LocalNetworkService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private modalService: NgbModal
  ) { }

  ngOnInit() {
    // Check if user has admin role before allowing template to render
    if (!this.keycloakService.hasAdminRole()) {
      this.router.navigate(['/']);
      return;
    }
    // Only set authorized to true after verification
    this.isAuthorized = true;
    
    // Load device mappings on startup to enable MAC address comparison
    this.loadDeviceMappingsSilently();
    
    // Load scheduler enabled status
    this.loadScanSchedulerStatus();
  }

  /**
   * Load device mappings silently (without showing modal)
   * This is used to enable MAC address comparison for new device detection
   */
  private loadDeviceMappingsSilently(): void {
    this.localNetworkService.getDeviceMappings().subscribe({
      next: (response) => {
        if (response && response.devices) {
          this.deviceMappings = response.devices;
        } else if (response && Array.isArray(response)) {
          this.deviceMappings = response;
        } else {
          this.deviceMappings = [];
        }
      },
      error: (error) => {
        // Silently fail - mappings will be loaded when modal is opened
        this.deviceMappings = [];
      }
    });
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
    this.scanSubscription = this.localNetworkService.scanNetworkStream(this.useExternalVendorAPI).subscribe({
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
        break;
    }
  }

  private addOrUpdateDevice(deviceData: any): void {
    if (!deviceData) {
      return;
    }
    
    // Fix: Ensure macAddressSource is always set if macAddress exists
    if (deviceData.macAddress && !deviceData.macAddressSource) {
      // Try to determine source - if we have MongoDB mapping service, check it
      // For now, default to 'mongodb' if MAC exists but source is missing
      // This will be corrected by backend, but this is a safety net
      deviceData.macAddressSource = 'mongodb';
      deviceData.macAddressConflict = false;
    }

    // Fix: Ensure macAddressSource is always set if macAddress exists
    if ((deviceData.macAddress || deviceData.mac) && !deviceData.macAddressSource) {
      // Default to 'mongodb' if MAC exists but source is missing
      // This will be corrected by backend, but this is a safety net
      deviceData.macAddressSource = 'mongodb';
      deviceData.macAddressConflict = false;
    }
    
    const device: NetworkDevice = {
      ipAddress: deviceData.ipAddress || deviceData.ip,
      hostname: deviceData.hostname || deviceData.host_name || null,
      macAddress: deviceData.macAddress || deviceData.mac,
      macAddressSource: deviceData.macAddressSource,
      macAddressARP: deviceData.macAddressARP,
      macAddressMongoDB: deviceData.macAddressMongoDB,
      macAddressConflict: deviceData.macAddressConflict,
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
    // Show new device icon if device is new
    if (this.isNewDevice(device)) {
      return 'fa-star';
    }
    
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
            this.mappingsInfo = 'La collection MongoDB est vide. Utilisez le bouton "Ajouter" pour créer un nouveau mapping.';
          }
        } else if (response && Array.isArray(response)) {
          // Handle case where response is directly an array
          this.deviceMappings = response;
          this.mappingsError = '';
          if (this.deviceMappings.length === 0) {
            this.mappingsInfo = 'La collection MongoDB est vide. Utilisez le bouton "Ajouter" pour créer un nouveau mapping.';
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
   * Lookup vendor by OUI (format: XX:XX:XX)
   * Converts OUI to MAC address and opens vendor info modal
   */
  lookupVendorByOUI(): void {
    if (!this.ouiInput || this.ouiInput.trim() === '') {
      return;
    }

    // Normalize OUI input (remove spaces, ensure format)
    let oui = this.ouiInput.trim().replace(/\s+/g, '');
    
    // Validate format (should be XX:XX:XX or XXXXXX)
    const ouiPattern = /^([0-9A-Fa-f]{2}[:-]?){2}[0-9A-Fa-f]{2}$/;
    if (!ouiPattern.test(oui)) {
      // Try to format if user entered without separators
      if (oui.length === 6 && /^[0-9A-Fa-f]{6}$/.test(oui)) {
        oui = oui.substring(0, 2) + ':' + oui.substring(2, 4) + ':' + oui.substring(4, 6);
      } else {
        alert('Format OUI invalide. Utilisez le format XX:XX:XX (ex: 00:11:22)');
        return;
      }
    }
    
    // Ensure format is XX:XX:XX
    if (oui.includes('-')) {
      oui = oui.replace(/-/g, ':');
    }
    if (!oui.includes(':')) {
      oui = oui.substring(0, 2) + ':' + oui.substring(2, 4) + ':' + oui.substring(4, 6);
    }
    
    // Convert OUI to MAC address (append 00:00:00 to make it a valid MAC)
    const macAddress = oui.toUpperCase() + ':00:00:00';
    
    // Open vendor info modal with the constructed MAC address
    this.openVendorInfoModal(macAddress);
    
    // Clear input after lookup
    this.ouiInput = '';
  }

  /**
   * Open vendor info modal and fetch vendor information from API
   * Also updates the device card with the vendor information if found
   */
  openVendorInfoModal(macAddress: string): void {
    if (!macAddress || macAddress.trim() === '') {
      return;
    }

    this.vendorInfo = null;
    this.vendorInfoError = '';
    this.isLoadingVendorInfo = true;

    // Open modal first
    this.vendorInfoModalRef = this.modalService.open(this.vendorInfoModal, {
      size: 'lg',
      windowClass: 'slideshow-modal-wide',
      backdrop: 'static',
      keyboard: true
    });

    // Fetch vendor info from API
    this.localNetworkService.getVendorInfo(macAddress).subscribe({
      next: (response) => {
        this.ngZone.run(() => {
          this.isLoadingVendorInfo = false;
          this.vendorInfo = response;
          if (!response.success) {
            this.vendorInfoError = response.error || 'Failed to retrieve vendor information';
          } else if (response.success && response.vendor) {
            // Update the device card with the vendor information
            this.updateDeviceVendor(macAddress, response.vendor);
          }
          this.cdr.detectChanges();
        });
      },
      error: (error) => {
        this.ngZone.run(() => {
          this.isLoadingVendorInfo = false;
          this.vendorInfoError = error.error?.message || error.message || 'Error retrieving vendor information';
          this.vendorInfo = { success: false, error: this.vendorInfoError, macAddress: macAddress };
          this.cdr.detectChanges();
        });
      }
    });
  }

  /**
   * Update device vendor in the devices array
   * @param macAddress MAC address to find the device
   * @param vendor Vendor name to set
   */
  private updateDeviceVendor(macAddress: string, vendor: string): void {
    if (!macAddress || !vendor) {
      return;
    }

    // Normalize MAC addresses for comparison
    const normalizeMac = (mac: string): string => {
      return mac ? mac.replace(/[:-]/g, '').toUpperCase().trim() : '';
    };

    const normalizedMac = normalizeMac(macAddress);

    // Find device by MAC address (check both macAddress and macAddressMongoDB)
    const deviceIndex = this.devices.findIndex(device => {
      const deviceMac = normalizeMac(device.macAddress || '');
      const deviceMacMongo = normalizeMac(device.macAddressMongoDB || '');
      return deviceMac === normalizedMac || deviceMacMongo === normalizedMac;
    });

    if (deviceIndex !== -1) {
      // Update the device with the vendor information
      this.devices[deviceIndex].vendor = vendor;
      // Create a new array to trigger change detection
      this.devices = [...this.devices];
      this.cdr.detectChanges();
    }
  }

  /**
   * Close vendor info modal
   */
  closeVendorInfoModal(): void {
    if (this.vendorInfoModalRef) {
      this.vendorInfoModalRef.close();
      this.vendorInfoModalRef = undefined;
    }
    this.vendorInfo = null;
    this.vendorInfoError = '';
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

  /**
   * Helper function to compare IP addresses numerically
   */
  private compareIpAddresses(ipA: string, ipB: string): number {
    const aParts = (ipA || '').split('.').map(p => parseInt(p, 10) || 0);
    const bParts = (ipB || '').split('.').map(p => parseInt(p, 10) || 0);
    for (let i = 0; i < 4; i++) {
      const aPart = aParts[i] || 0;
      const bPart = bParts[i] || 0;
      if (aPart !== bPart) {
        return aPart - bPart;
      }
    }
    return 0;
  }

  /**
   * Get sorted devices based on current sort settings and filter
   */
  getSortedDevices(): NetworkDevice[] {
    if (!this.devices || this.devices.length === 0) {
      return [];
    }

    // First, filter devices by name, IP address, MAC address, and vendor
    let filtered = [...this.devices];
    if (this.deviceFilter && this.deviceFilter.trim()) {
      const filterLower = this.deviceFilter.trim().toLowerCase();
      filtered = this.devices.filter(device => {
        const hostname = (device.hostname || '').toLowerCase();
        const ipAddress = (device.ipAddress || '').toLowerCase();
        const macAddress = (device.macAddress || '').toLowerCase();
        const macAddressMongoDB = (device.macAddressMongoDB || '').toLowerCase();
        const vendor = (device.vendor || '').toLowerCase();
        return hostname.includes(filterLower) || 
               ipAddress.includes(filterLower) || 
               macAddress.includes(filterLower) ||
               macAddressMongoDB.includes(filterLower) ||
               vendor.includes(filterLower);
      });
    }

    const sortBy = this.deviceSortBy;
    const isSortingByIp = sortBy === 'ip';
    const sorted = filtered.sort((a, b) => {
      let comparison = 0;
      let needsSecondarySort = false;

      switch (sortBy) {
        case 'vulnerabilities':
          // Sort by vulnerability count first (descending by default)
          const aVulnCount = a.vulnerabilities?.length || 0;
          const bVulnCount = b.vulnerabilities?.length || 0;
          if (aVulnCount !== bVulnCount) {
            comparison = this.deviceSortDirection === 'desc' 
              ? bVulnCount - aVulnCount 
              : aVulnCount - bVulnCount;
            return comparison;
          }
          // If same vulnerability count, sort by severity
          const aMaxSeverity = this.getMaxSeverityValue(a);
          const bMaxSeverity = this.getMaxSeverityValue(b);
          if (aMaxSeverity !== bMaxSeverity) {
            comparison = this.deviceSortDirection === 'desc'
              ? bMaxSeverity - aMaxSeverity
              : aMaxSeverity - bMaxSeverity;
            return comparison;
          }
          // If same severity, need secondary IP sort
          needsSecondarySort = true;
          break;

        case 'ip':
          // Sort IP addresses numerically
          comparison = this.compareIpAddresses(a.ipAddress || '', b.ipAddress || '');
          return this.deviceSortDirection === 'asc' ? comparison : -comparison;

        case 'name':
          // Sort by hostname or IP if no hostname
          const aName = (a.hostname || a.ipAddress || '').toLowerCase();
          const bName = (b.hostname || b.ipAddress || '').toLowerCase();
          if (aName < bName) {
            comparison = this.deviceSortDirection === 'asc' ? -1 : 1;
          } else if (aName > bName) {
            comparison = this.deviceSortDirection === 'asc' ? 1 : -1;
          } else {
            // If equal, need secondary IP sort
            needsSecondarySort = true;
          }
          if (comparison !== 0) return comparison;
          break;

        case 'type':
          // Sort by device type
          const aType = (a.deviceType || 'Unknown').toLowerCase();
          const bType = (b.deviceType || 'Unknown').toLowerCase();
          if (aType < bType) {
            comparison = this.deviceSortDirection === 'asc' ? -1 : 1;
          } else if (aType > bType) {
            comparison = this.deviceSortDirection === 'asc' ? 1 : -1;
          } else {
            // If equal, need secondary IP sort
            needsSecondarySort = true;
          }
          if (comparison !== 0) return comparison;
          break;

        case 'status':
          // Sort by status (online, offline, unknown)
          const statusOrder = { 'online': 1, 'offline': 2, 'unknown': 3 };
          const aStatus = statusOrder[a.status] || 3;
          const bStatus = statusOrder[b.status] || 3;
          comparison = this.deviceSortDirection === 'asc' 
            ? aStatus - bStatus 
            : bStatus - aStatus;
          if (comparison === 0) {
            // If equal, need secondary IP sort
            needsSecondarySort = true;
          } else {
            return comparison;
          }
          break;
      }

      // Secondary sort by IP if needed and not already sorting by IP
      if (needsSecondarySort && !isSortingByIp) {
        return this.compareIpAddresses(a.ipAddress || '', b.ipAddress || '');
      }

      return comparison;
    });

    return sorted;
  }

  /**
   * Get numeric value for severity (higher = more severe)
   */
  private getMaxSeverityValue(device: NetworkDevice): number {
    if (!device.vulnerabilities || device.vulnerabilities.length === 0) {
      return 0;
    }
    const severityValues: { [key: string]: number } = {
      'critical': 5,
      'high': 4,
      'medium': 3,
      'low': 2,
      'info': 1
    };
    return Math.max(...device.vulnerabilities.map(v => severityValues[v.severity] || 0));
  }

  /**
   * Change device sort order
   */
  changeDeviceSort(sortBy: 'ip' | 'name' | 'type' | 'vulnerabilities' | 'status'): void {
    if (this.deviceSortBy === sortBy) {
      // Toggle direction if same column
      this.deviceSortDirection = this.deviceSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      // New column, set default direction
      this.deviceSortBy = sortBy;
      // Vulnerabilities should default to desc (most vulnerable first)
      // Others default to asc
      this.deviceSortDirection = sortBy === 'vulnerabilities' ? 'desc' : 'asc';
    }
    this.cdr.detectChanges();
  }

  /**
   * Get sort icon for device sort dropdown
   */
  getDeviceSortIcon(sortBy: string): string {
    if (this.deviceSortBy !== sortBy) {
      return '';
    }
    return this.deviceSortDirection === 'asc' ? 'fa-sort-up' : 'fa-sort-down';
  }

  /**
   * Check if a device has the same MAC address in MongoDB but with a different IP
   * This indicates the same physical device but with a changed IP address
   */
  hasDifferentIPInMongoDB(device: NetworkDevice): boolean {
    // If device has no MAC address, we cannot determine
    if (!device.macAddress) {
      return false;
    }
    
    // Normalize MAC address for comparison (uppercase, remove separators)
    const normalizeMac = (mac: string): string => {
      return mac.trim().toUpperCase().replace(/[:-]/g, '').replace(/\s/g, '');
    };
    
    const deviceMac = normalizeMac(device.macAddress);
    
    // Check if MAC address exists in the loaded device mappings with a different IP
    if (this.deviceMappings && this.deviceMappings.length > 0) {
      const mappingWithSameMac = this.deviceMappings.find(mapping => {
        if (!mapping.macAddress) {
          return false;
        }
        const mappingMac = normalizeMac(mapping.macAddress);
        return mappingMac === deviceMac;
      });
      
      // If we found a mapping with the same MAC but different IP, it's a different IP
      if (mappingWithSameMac && mappingWithSameMac.ipAddress !== device.ipAddress) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Get count of unknown devices (not in MongoDB)
   */
  getUnknownDevicesCount(): number {
    if (!this.devices || this.devices.length === 0) {
      return 0;
    }
    return this.devices.filter(device => this.isNewDevice(device)).length;
  }

  /**
   * Get count of known devices (in MongoDB)
   */
  getKnownDevicesCount(): number {
    if (!this.devices || this.devices.length === 0) {
      return 0;
    }
    return this.devices.filter(device => !this.isNewDevice(device)).length;
  }

  /**
   * Check if a device is new (not in MongoDB)
   * A device is considered new if its MAC address does not exist in MongoDB mappings
   * This is based on MAC address comparison, not IP address
   */
  isNewDevice(device: NetworkDevice): boolean {
    // If device has no MAC address, we cannot determine if it's new
    if (!device.macAddress) {
      return false;
    }
    
    // If macAddressSource is 'mongodb', the device is definitely in MongoDB (not new)
    if (device.macAddressSource === 'mongodb') {
      return false;
    }
    
    // Normalize MAC address for comparison (uppercase, remove separators)
    const normalizeMac = (mac: string): string => {
      return mac.trim().toUpperCase().replace(/[:-]/g, '').replace(/\s/g, '');
    };
    
    const deviceMac = normalizeMac(device.macAddress);
    
    // Check if macAddressMongoDB exists and matches the device MAC
    // This means there's a MongoDB mapping for this IP with this MAC
    if (device.macAddressMongoDB) {
      const mongoMac = normalizeMac(device.macAddressMongoDB);
      if (mongoMac === deviceMac) {
        // MAC address matches MongoDB mapping - device is in MongoDB
        return false;
      }
      // If macAddressMongoDB exists but differs, there's still a mapping for this IP
      // So the device is known (even if MAC changed)
      return false;
    }
    
    // Check if MAC address exists in the loaded device mappings
    // This handles cases where the MAC might be in MongoDB but associated with a different IP
    if (this.deviceMappings && this.deviceMappings.length > 0) {
      const mappingWithSameMac = this.deviceMappings.find(mapping => {
        if (!mapping.macAddress) {
          return false;
        }
        const mappingMac = normalizeMac(mapping.macAddress);
        return mappingMac === deviceMac;
      });
      
      // If MAC exists in MongoDB mappings, device is not new
      // (even if IP is different, it's still the same device)
      if (mappingWithSameMac) {
        return false;
      }
    }
    
    // If we reach here:
    // - Device has a MAC address
    // - MAC source is 'arp' or 'local' (not 'mongodb')
    // - No macAddressMongoDB (no mapping for this IP)
    // - MAC address not found in loaded mappings
    // This means it's a new device
    return device.macAddressSource === 'arp' || device.macAddressSource === 'local';
  }

  /**
   * Calculate the next available device number
   */
  private getNextDeviceNumber(): number {
    if (!this.deviceMappings || this.deviceMappings.length === 0) {
      return 1;
    }
    
    // Find the maximum device number
    const maxNumber = this.deviceMappings
      .map(m => m.deviceNumber)
      .filter(num => num !== null && num !== undefined)
      .reduce((max, num) => Math.max(max, num), 0);
    
    return maxNumber + 1;
  }

  /**
   * Show form to create a new device mapping
   * @param deviceData Optional device data to pre-populate the form
   */
  showCreateMappingForm(deviceData?: NetworkDevice): void {
    this.editingMapping = null;
    const nextDeviceNumber = this.getNextDeviceNumber();
    
    if (deviceData) {
      // Pre-populate form with device data
      this.mappingForm = {
        ipAddress: deviceData.ipAddress || '',
        deviceName: deviceData.hostname || deviceData.ipAddress || '',
        macAddress: deviceData.macAddress || '',
        deviceNumber: nextDeviceNumber
      };
    } else {
      // Empty form
      this.mappingForm = {
        ipAddress: '',
        deviceName: '',
        macAddress: '',
        deviceNumber: nextDeviceNumber
      };
    }
    this.showMappingForm = true;
    this.mappingsError = '';
    this.mappingsInfo = '';
  }

  /**
   * Open device mappings modal and pre-populate form with device data
   */
  openMappingModalForDevice(device: NetworkDevice): void {
    // Open the modal first
    this.openDeviceMappingsModal();
    
    // Load mappings first to ensure we can calculate the next device number
    this.isLoadingMappings = true;
    this.localNetworkService.getDeviceMappings().subscribe({
      next: (response) => {
        if (response && response.devices) {
          this.deviceMappings = response.devices;
        } else if (response && Array.isArray(response)) {
          this.deviceMappings = response;
        } else {
          this.deviceMappings = [];
        }
        this.isLoadingMappings = false;
        
        // Wait for modal to open, then show the form with pre-populated data
        setTimeout(() => {
          this.showCreateMappingForm(device);
        }, 100);
      },
      error: (error) => {
        this.isLoadingMappings = false;
        this.mappingsError = 'Erreur lors du chargement des mappings';
        // Still show the form even if loading failed
        setTimeout(() => {
          this.showCreateMappingForm(device);
        }, 100);
      }
    });
  }

  /**
   * Edit device in MongoDB - opens modal and finds existing mapping or creates new one
   */
  editDeviceInMongoDB(device: NetworkDevice): void {
    // Open the modal first
    this.openDeviceMappingsModal();
    
    // Load mappings to find existing mapping
    this.isLoadingMappings = true;
    this.localNetworkService.getDeviceMappings().subscribe({
      next: (response) => {
        if (response && response.devices) {
          this.deviceMappings = response.devices;
        } else if (response && Array.isArray(response)) {
          this.deviceMappings = response;
        } else {
          this.deviceMappings = [];
        }
        this.isLoadingMappings = false;
        
        // Normalize MAC addresses for comparison
        const normalizeMac = (mac: string | null | undefined): string => {
          if (!mac) return '';
          return mac.replace(/[:-]/g, '').toUpperCase();
        };
        
        const deviceMac = normalizeMac(device.macAddress || device.macAddressMongoDB);
        
        // Try to find existing mapping by IP or MAC address
        const existingMapping = this.deviceMappings.find(m => {
          const mappingMac = normalizeMac(m.macAddress);
          return m.ipAddress === device.ipAddress || 
                 (deviceMac && mappingMac && mappingMac === deviceMac);
        });
        
        // Wait for modal to open, then show the form
        setTimeout(() => {
          if (existingMapping) {
            // Edit existing mapping
            this.editMapping(existingMapping);
          } else {
            // Create new mapping with device data
            this.showCreateMappingForm(device);
          }
        }, 100);
      },
      error: (error) => {
        this.isLoadingMappings = false;
        this.mappingsError = 'Erreur lors du chargement des mappings';
        // Still show the form even if loading failed
        setTimeout(() => {
          this.showCreateMappingForm(device);
        }, 100);
      }
    });
  }

  /**
   * Show form to edit an existing device mapping
   */
  editMapping(mapping: any): void {
    this.editingMapping = mapping;
    this.mappingForm = {
      ipAddress: mapping.ipAddress || '',
      deviceName: mapping.deviceName || '',
      macAddress: mapping.macAddress || '',
      deviceNumber: mapping.deviceNumber || null
    };
    this.showMappingForm = true;
    this.mappingsError = '';
    this.mappingsInfo = '';
  }

  /**
   * Cancel form editing
   */
  cancelMappingForm(): void {
    this.showMappingForm = false;
    this.editingMapping = null;
    this.mappingForm = {
      ipAddress: '',
      deviceName: '',
      macAddress: '',
      deviceNumber: null
    };
    this.mappingsError = '';
  }

  /**
   * Save device mapping (create or update)
   */
  saveDeviceMapping(): void {
    if (!this.mappingForm.ipAddress || !this.mappingForm.deviceName) {
      this.mappingsError = 'IP address and device name are required';
      return;
    }

    this.isSavingMapping = true;
    this.mappingsError = '';
    this.mappingsInfo = '';

    const mappingData: any = {
      ipAddress: this.mappingForm.ipAddress.trim(),
      deviceName: this.mappingForm.deviceName.trim()
    };

    if (this.mappingForm.macAddress && this.mappingForm.macAddress.trim()) {
      mappingData.macAddress = this.mappingForm.macAddress.trim();
    }

    if (this.mappingForm.deviceNumber !== null && this.mappingForm.deviceNumber !== undefined) {
      mappingData.deviceNumber = this.mappingForm.deviceNumber;
    }

    const operation = this.editingMapping
      ? this.localNetworkService.updateDeviceMapping(this.editingMapping.id, mappingData)
      : this.localNetworkService.createDeviceMapping(mappingData);

    const isEdit = !!this.editingMapping;
    operation.subscribe({
      next: (response) => {
        this.ngZone.run(() => {
          this.isSavingMapping = false;
          this.showMappingForm = false;
          this.mappingsInfo = isEdit 
            ? 'Device mapping updated successfully' 
            : 'Device mapping created successfully';
          this.editingMapping = null;
          this.mappingsError = '';
          this.cdr.detectChanges();
          
          // Reload mappings after save
          setTimeout(() => {
            this.ngZone.run(() => {
              this.loadDeviceMappings();
            });
          }, 500);
        });
      },
      error: (error) => {
        this.ngZone.run(() => {
          this.isSavingMapping = false;
          if (error?.error?.message) {
            this.mappingsError = `Error: ${error.error.message}`;
          } else if (error?.error?.error) {
            this.mappingsError = `Error: ${error.error.error}`;
          } else {
            this.mappingsError = `Error: ${error?.message || 'Unknown error'}`;
          }
          this.cdr.detectChanges();
        });
      }
    });
  }

  /**
   * Delete device mapping with confirmation
   */
  deleteMapping(mapping: any): void {
    if (!confirm(`Are you sure you want to delete the mapping for ${mapping.deviceName} (${mapping.ipAddress})?`)) {
      return;
    }

    this.mappingsError = '';
    this.mappingsInfo = 'Deleting...';

    this.localNetworkService.deleteDeviceMapping(mapping.id).subscribe({
      next: (response) => {
        this.ngZone.run(() => {
          this.mappingsInfo = 'Device mapping deleted successfully';
          this.mappingsError = '';
          this.cdr.detectChanges();
          
          // Reload mappings after delete
          setTimeout(() => {
            this.ngZone.run(() => {
              this.loadDeviceMappings();
            });
          }, 500);
        });
      },
      error: (error) => {
        this.ngZone.run(() => {
          this.mappingsInfo = '';
          if (error?.error?.message) {
            this.mappingsError = `Error: ${error.error.message}`;
          } else if (error?.error?.error) {
            this.mappingsError = `Error: ${error.error.error}`;
          } else {
            this.mappingsError = `Error: ${error?.message || 'Unknown error'}`;
          }
          this.cdr.detectChanges();
        });
      }
    });
  }

  getMacAddressSourceTooltip(device: any): string {
    if (device.macAddressConflict) {
      return `Conflict: MongoDB MAC (${device.macAddress}) differs from ARP MAC (${device.macAddressARP})`;
    }
    switch (device.macAddressSource) {
      case 'mongodb':
        return 'MAC address from MongoDB mapping';
      case 'arp':
        return 'MAC address from ARP table';
      case 'local':
        return 'MAC address from local interface';
      default:
        return 'MAC address source unknown';
    }
  }

  getMacAddressClass(device: any): string {
    if (device.macAddressSource === 'mongodb') {
      return 'text-primary';
    } else if (device.macAddressSource === 'arp') {
      return 'text-info';
    } else if (device.macAddressSource === 'local') {
      return 'text-secondary';
    } else {
      // Default color if source is unknown
      return 'text-secondary';
    }
  }

  getMacAddressColor(device: any): string {
    if (device.macAddressSource === 'mongodb') {
      return '#ff9800'; // Orange pour MongoDB
    } else if (device.macAddressSource === 'arp') {
      return '#28a745'; // Vert pour ARP (adresse MAC réelle du device réseau)
    } else if (device.macAddressSource === 'local') {
      return '#007bff'; // Bleu pour Local
    } else {
      // Default color if source is unknown - but this should not happen if MAC exists
      // If MAC exists but source is unknown, it might be from MongoDB but source wasn't set
      // In this case, we'll use orange (MongoDB) as the most likely source
      if (device.macAddress) {
        return '#ff9800'; // Orange par défaut si MAC existe mais source inconnue (probablement MongoDB)
      }
      return '#007bff'; // Bleu seulement si vraiment aucune MAC
    }
  }

  hasMacConflict(device: any): boolean {
    // Check if there's a conflict (both MAC addresses exist and are different)
    // Handle both boolean true and string "true" (JSON serialization)
    if (device.macAddressConflict === true || device.macAddressConflict === 'true' || device.macAddressConflict === 1) {
      return true;
    }
    // Also check if both MAC addresses exist and are different
    // ARP is now the primary MAC, MongoDB is stored in macAddressMongoDB
    if (device.macAddress && device.macAddressMongoDB) {
      const arpMac = device.macAddress.trim().toUpperCase();
      const mongoMac = device.macAddressMongoDB.trim().toUpperCase();
      if (arpMac !== mongoMac) {
        return true;
      }
    }
    // Legacy check for old format (macAddressARP)
    if (device.macAddress && device.macAddressARP) {
      const arpMac = device.macAddress.trim().toUpperCase();
      const arpMac2 = device.macAddressARP.trim().toUpperCase();
      if (arpMac !== arpMac2) {
        return true;
      }
    }
    return false;
  }

  /**
   * Open MAC vendor mappings modal and load data from MongoDB
   */
  openMacVendorMappingsModal(): void {
    this.isLoadingMacVendorMappings = true;
    this.macVendorMappings = [];
    this.macVendorMappingsError = '';
    this.macVendorMappingsInfo = '';
    
    this.macVendorMappingsModalRef = this.modalService.open(this.macVendorMappingsModal, {
      size: 'xl',
      windowClass: 'slideshow-modal-wide',
      backdrop: 'static',
      keyboard: true
    });

    this.loadMacVendorMappings();
  }

  loadMacVendorMappings(): void {
    this.isLoadingMacVendorMappings = true;
    this.macVendorMappingsError = '';
    this.macVendorMappingsInfo = '';
    
    this.localNetworkService.getMacVendorMappings().subscribe({
      next: (response) => {
        if (response && response.mappings) {
          this.macVendorMappings = response.mappings;
          this.macVendorMappingsError = '';
          if (this.macVendorMappings.length === 0) {
            this.macVendorMappingsInfo = 'La collection MongoDB est vide. Utilisez le bouton "Ajouter" pour créer un nouveau mapping.';
          }
        } else if (response && Array.isArray(response)) {
          // Handle case where response is directly an array
          this.macVendorMappings = response;
          this.macVendorMappingsError = '';
          if (this.macVendorMappings.length === 0) {
            this.macVendorMappingsInfo = 'La collection MongoDB est vide. Utilisez le bouton "Ajouter" pour créer un nouveau mapping.';
          }
        } else {
          this.macVendorMappings = [];
          this.macVendorMappingsInfo = 'Aucune donnée trouvée dans la réponse. La collection MongoDB est peut-être vide.';
        }
        
        // Initialize sorted array - sort by OUI by default
        this.macVendorSortColumn = 'oui';
        this.macVendorSortDirection = 'asc';
        this.sortedMacVendorMappings = [...this.macVendorMappings].sort((a, b) => {
          const aValue = (a.oui || '').toLowerCase();
          const bValue = (b.oui || '').toLowerCase();
          if (aValue < bValue) return -1;
          if (aValue > bValue) return 1;
          return 0;
        });
        
        this.isLoadingMacVendorMappings = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        this.isLoadingMacVendorMappings = false;
        this.macVendorMappings = [];
        
        if (error?.status === 403) {
          this.macVendorMappingsError = 'Accès refusé. Vous devez avoir le rôle administrateur.';
        } else if (error?.status === 404) {
          this.macVendorMappingsError = 'Endpoint non trouvé. Vérifiez la configuration du backend.';
        } else if (error?.error?.message) {
          this.macVendorMappingsError = `Erreur: ${error.error.message}`;
        } else {
          this.macVendorMappingsError = `Erreur lors du chargement: ${error?.message || 'Erreur inconnue'}`;
        }
        
        this.cdr.detectChanges();
      }
    });
  }

  /**
   * Close MAC vendor mappings modal
   */
  closeMacVendorMappingsModal(): void {
    if (this.macVendorMappingsModalRef) {
      this.macVendorMappingsModalRef.close();
      this.macVendorMappingsModalRef = undefined;
    }
  }

  /**
   * Sort MAC vendor mappings by column
   */
  sortMacVendorMappings(column: string): void {
    if (this.macVendorSortColumn === column) {
      // Toggle direction if same column
      this.macVendorSortDirection = this.macVendorSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      // New column, start with ascending
      this.macVendorSortColumn = column;
      this.macVendorSortDirection = 'asc';
    }

    this.sortedMacVendorMappings = [...this.macVendorMappings].sort((a, b) => {
      let aValue: any;
      let bValue: any;

      if (column === 'oui') {
        aValue = (a.oui || '').toLowerCase();
        bValue = (b.oui || '').toLowerCase();
      } else if (column === 'vendor') {
        aValue = (a.vendor || '').toLowerCase();
        bValue = (b.vendor || '').toLowerCase();
      } else if (column === 'dateCreation') {
        aValue = a.dateCreation ? new Date(a.dateCreation).getTime() : 0;
        bValue = b.dateCreation ? new Date(b.dateCreation).getTime() : 0;
      } else if (column === 'dateModification') {
        aValue = a.dateModification ? new Date(a.dateModification).getTime() : 0;
        bValue = b.dateModification ? new Date(b.dateModification).getTime() : 0;
      } else {
        return 0;
      }

      if (aValue < bValue) {
        return this.macVendorSortDirection === 'asc' ? -1 : 1;
      } else if (aValue > bValue) {
        return this.macVendorSortDirection === 'asc' ? 1 : -1;
      }
      return 0;
    });

    this.cdr.detectChanges();
  }

  /**
   * Get sort icon for MAC vendor mapping column header
   */
  getMacVendorSortIcon(column: string): string {
    if (this.macVendorSortColumn !== column) {
      return 'fa-sort';
    }
    return this.macVendorSortDirection === 'asc' ? 'fa-sort-up' : 'fa-sort-down';
  }

  /**
   * Show form to create a new MAC vendor mapping
   */
  showCreateMacVendorMappingForm(): void {
    this.editingMacVendorMapping = null;
    this.macVendorMappingForm = {
      oui: '',
      vendor: ''
    };
    this.showMacVendorMappingForm = true;
    this.macVendorMappingsError = '';
    this.macVendorMappingsInfo = '';
  }

  /**
   * Show form to edit an existing MAC vendor mapping
   */
  editMacVendorMapping(mapping: any): void {
    this.editingMacVendorMapping = mapping;
    this.macVendorMappingForm = {
      oui: mapping.oui || '',
      vendor: mapping.vendor || ''
    };
    this.showMacVendorMappingForm = true;
    this.macVendorMappingsError = '';
    this.macVendorMappingsInfo = '';
  }

  /**
   * Cancel form editing
   */
  cancelMacVendorMappingForm(): void {
    this.showMacVendorMappingForm = false;
    this.editingMacVendorMapping = null;
    this.macVendorMappingForm = {
      oui: '',
      vendor: ''
    };
    this.macVendorMappingsError = '';
  }

  /**
   * Save MAC vendor mapping (create or update)
   */
  saveMacVendorMapping(): void {
    if (!this.macVendorMappingForm.oui || !this.macVendorMappingForm.vendor) {
      this.macVendorMappingsError = 'OUI et vendor sont requis';
      return;
    }

    // Normalize OUI format
    let oui = this.macVendorMappingForm.oui.trim().toUpperCase().replace(/-/g, ':');
    
    // Validate OUI format
    if (!oui.match(/^([0-9A-F]{2}:){2}[0-9A-F]{2}$/)) {
      this.macVendorMappingsError = 'Format OUI invalide. Format attendu: XX:XX:XX (ex: 00:11:22)';
      return;
    }

    this.isSavingMacVendorMapping = true;
    this.macVendorMappingsError = '';
    this.macVendorMappingsInfo = '';

    const mappingData: any = {
      oui: oui,
      vendor: this.macVendorMappingForm.vendor.trim()
    };

    const operation = this.editingMacVendorMapping
      ? this.localNetworkService.updateMacVendorMapping(this.editingMacVendorMapping.id, mappingData)
      : this.localNetworkService.createMacVendorMapping(mappingData);

    const isEdit = !!this.editingMacVendorMapping;
    operation.subscribe({
      next: (response) => {
        this.ngZone.run(() => {
          this.isSavingMacVendorMapping = false;
          this.showMacVendorMappingForm = false;
          this.macVendorMappingsInfo = isEdit 
            ? 'MAC vendor mapping mis à jour avec succès' 
            : 'MAC vendor mapping créé avec succès';
          this.editingMacVendorMapping = null;
          this.macVendorMappingsError = '';
          this.cdr.detectChanges();
          
          // Reload mappings after save
          setTimeout(() => {
            this.ngZone.run(() => {
              this.loadMacVendorMappings();
            });
          }, 500);
        });
      },
      error: (error) => {
        this.ngZone.run(() => {
          this.isSavingMacVendorMapping = false;
          if (error?.error?.message) {
            this.macVendorMappingsError = `Erreur: ${error.error.message}`;
          } else if (error?.error?.error) {
            this.macVendorMappingsError = `Erreur: ${error.error.error}`;
          } else {
            this.macVendorMappingsError = `Erreur: ${error?.message || 'Erreur inconnue'}`;
          }
          this.cdr.detectChanges();
        });
      }
    });
  }

  /**
   * Delete MAC vendor mapping with confirmation
   */
  deleteMacVendorMapping(mapping: any): void {
    if (!confirm(`Êtes-vous sûr de vouloir supprimer le mapping pour ${mapping.oui} (${mapping.vendor})?`)) {
      return;
    }

    this.macVendorMappingsError = '';
    this.macVendorMappingsInfo = 'Suppression...';

    this.localNetworkService.deleteMacVendorMapping(mapping.id).subscribe({
      next: (response) => {
        this.ngZone.run(() => {
          this.macVendorMappingsInfo = 'MAC vendor mapping supprimé avec succès';
          this.macVendorMappingsError = '';
          this.cdr.detectChanges();
          
          // Reload mappings after delete
          setTimeout(() => {
            this.ngZone.run(() => {
              this.loadMacVendorMappings();
            });
          }, 500);
        });
      },
      error: (error) => {
        this.ngZone.run(() => {
          this.macVendorMappingsInfo = '';
          if (error?.error?.message) {
            this.macVendorMappingsError = `Erreur: ${error.error.message}`;
          } else if (error?.error?.error) {
            this.macVendorMappingsError = `Erreur: ${error.error.error}`;
          } else {
            this.macVendorMappingsError = `Erreur: ${error?.message || 'Erreur inconnue'}`;
          }
          this.cdr.detectChanges();
        });
      }
    });
  }

  /**
   * Load scan scheduler enabled status from backend
   */
  loadScanSchedulerStatus(): void {
    this.isLoadingSchedulerStatus = true;
    this.localNetworkService.getScanSchedulerEnabled().subscribe({
      next: (response) => {
        this.ngZone.run(() => {
          this.isLoadingSchedulerStatus = false;
          if (response && response.enabled !== undefined) {
            this.scanSchedulerEnabled = response.enabled;
            console.log('Scan scheduler status loaded:', response.enabled);
          } else {
            console.warn('Invalid response from getScanSchedulerEnabled:', response);
            this.scanSchedulerEnabled = false;
          }
          this.cdr.detectChanges();
        });
      },
      error: (error) => {
        this.ngZone.run(() => {
          this.isLoadingSchedulerStatus = false;
          // Default to false on error
          this.scanSchedulerEnabled = false;
          console.error('Error loading scan scheduler status:', error);
          this.cdr.detectChanges();
        });
      }
    });
  }

  /**
   * Toggle scan scheduler enabled status
   */
  toggleScanScheduler(): void {
    // Prevent multiple clicks while loading
    if (this.isLoadingSchedulerStatus) {
      return;
    }
    
    const newValue = !this.scanSchedulerEnabled;
    // Optimistically update UI
    this.scanSchedulerEnabled = newValue;
    this.isLoadingSchedulerStatus = true;
    
    this.localNetworkService.setScanSchedulerEnabled(newValue).subscribe({
      next: (response) => {
        this.ngZone.run(() => {
          this.isLoadingSchedulerStatus = false;
          if (response && response.enabled !== undefined) {
            this.scanSchedulerEnabled = response.enabled;
          }
          // If response doesn't have enabled, keep the optimistic value
          this.cdr.detectChanges();
        });
      },
      error: (error) => {
        this.ngZone.run(() => {
          this.isLoadingSchedulerStatus = false;
          // Revert on error
          this.scanSchedulerEnabled = !newValue;
          this.cdr.detectChanges();
          console.error('Error updating scheduler status:', error);
          alert('Erreur lors de la mise à jour du statut du planificateur: ' + (error.error?.message || error.message || 'Erreur inconnue'));
        });
      }
    });
  }
}

