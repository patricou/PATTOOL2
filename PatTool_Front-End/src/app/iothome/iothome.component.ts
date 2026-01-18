import { Component, OnInit, ChangeDetectorRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { Member } from '../model/member';
import { IotService } from '../services/iot.service';
import { MembersService } from '../services/members.service';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions, ChartType } from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import { Chart, registerables } from 'chart.js';

// Register Chart.js components and zoom plugin
Chart.register(...registerables);
Chart.register(zoomPlugin);

export interface GoveeDevice {
  device: string;
  model: string;
  deviceName: string;
  controllable: boolean;
  retrievable: boolean;
  supportCmds?: string[];
  state?: GoveeDeviceState;
}

export interface GoveeDeviceState {
  temperature?: number | string;
  humidity?: number | string;
  powerState?: string;
  brightness?: number;
  color?: {
    r?: number;
    g?: number;
    b?: number;
  };
  colorTem?: number;
  online?: boolean;
  [key: string]: any; // For other potential state properties
}

@Component({
  selector: 'app-iothome',
  templateUrl: './iothome.component.html',
  styleUrls: ['./iothome.component.css'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NavigationButtonsModule, BaseChartDirective]
})
export class IothomeComponent implements OnInit {

  public user: Member = this._memberService.getUser();
  iotResponse: string = '';
  iotTestResponse: string = '';
  messageVisible: boolean = false;
  messageTestVisible: boolean = false;
  isLoadingPortail: boolean = false;
  isLoadingTest: boolean = false;
  
  // Govee properties
  goveeDevices: GoveeDevice[] = [];
  isLoadingGovee: boolean = false;
  goveeError: string = '';
  
  // Thermometer history properties
  thermometerHistory: any[] = [];
  thermometerHistoryByDevice: Map<string, any[]> = new Map();
  deviceColors: Map<string, string> = new Map();
  selectedDeviceId: string = '';
  showHistoryChart: boolean = false;
  isLoadingHistory: boolean = false;
  isRefreshingThermometers: boolean = false;
  isClearingHistory: boolean = false;
  historyError: string = '';
  
  // Scheduler status
  schedulerEnabled: boolean = true;
  isLoadingSchedulerStatus: boolean = false;
  isTogglingScheduler: boolean = false;
  
  // Store visibility state of datasets (by label) to preserve after refresh
  private datasetVisibilityState: Map<string, boolean> = new Map();
  
  // Toggle states for buttons
  allLinesVisible: boolean = true;
  temperaturesVisible: boolean = true;
  humiditiesVisible: boolean = true;
  
  // Color palette for different devices
  private colorPalette: string[] = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
    '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b',
    '#8e44ad', '#27ae60', '#d35400', '#2980b9', '#f1c40f'
  ];

  // Chart.js configuration
  @ViewChild(BaseChartDirective) chart?: BaseChartDirective;
  public selectedChartType: 'line' | 'bar' | 'scatter' = 'line';
  public lineChartData: ChartConfiguration<'line' | 'bar' | 'scatter'>['data'] = {
    datasets: [],
    labels: []
  };
  public lineChartOptions: ChartOptions<'line' | 'bar' | 'scatter'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        onClick: (e, legendItem, legend) => {
          // Toggle dataset visibility when clicking legend
          const index = legendItem.datasetIndex;
          if (index !== undefined) {
            const chart = legend.chart;
            const meta = chart.getDatasetMeta(index);
            const dataset = chart.data.datasets[index];
            const label = dataset.label || '';
            
            // Toggle visibility: if hidden is undefined, hide it, otherwise show it
            meta.hidden = meta.hidden ? false : true;
            
            // Save visibility state by label
            this.datasetVisibilityState.set(label, !meta.hidden); // true = visible, false = hidden
            
            chart.update();
          }
        },
        labels: {
          usePointStyle: true,
          padding: 15,
          font: {
            size: 12
          }
        }
      },
      tooltip: {
        enabled: true,
        position: 'nearest',
        intersect: false,
        mode: 'index',
        callbacks: {
          title: (tooltipItems) => {
            // Afficher l'heure dans le titre
            const index = tooltipItems[0].dataIndex;
            const labels = tooltipItems[0].chart.data.labels;
            return labels && labels[index] ? String(labels[index]) : '';
          },
          label: (context) => {
            let label = context.dataset.label || '';
            if (label) {
              label += ': ';
            }
            if (context.parsed.y !== null) {
              // Formater la valeur selon le type
              if (label.includes('Température')) {
                label += context.parsed.y.toFixed(2) + '°C';
              } else if (label.includes('Humidité')) {
                label += context.parsed.y.toFixed(2) + '%';
              } else {
                label += context.parsed.y.toFixed(2);
              }
            }
            return label;
          }
        }
      },
      zoom: {
        zoom: {
          wheel: {
            enabled: true,
          },
          pinch: {
            enabled: true
          },
          mode: 'x',
        },
        pan: {
          enabled: true,
          mode: 'x',
        }
      }
    },
    scales: {
      x: {
        display: true,
        title: {
          display: true,
          text: 'Temps'
        }
      },
      y: {
        type: 'linear',
        display: true,
        position: 'left',
        title: {
          display: true,
          text: 'Température (°C)'
        }
      },
      y1: {
        type: 'linear',
        display: true,
        position: 'right',
        title: {
          display: true,
          text: 'Humidité (%)'
        },
        grid: {
          drawOnChartArea: false,
        },
      }
    }
  };

  constructor(
    private _memberService: MembersService, 
    private _iotService: IotService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit() {
    this.loadGoveeDevices();
    this.loadSchedulerStatus();
  }
  
  loadSchedulerStatus(): void {
    if (this.isLoadingSchedulerStatus) {
      return;
    }
    
    this.isLoadingSchedulerStatus = true;
    this._iotService.getSchedulerStatus().subscribe({
      next: (response) => {
        if (response.success && response.enabled !== undefined) {
          this.schedulerEnabled = response.enabled;
        }
        this.isLoadingSchedulerStatus = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error("Error loading scheduler status:", error);
        this.isLoadingSchedulerStatus = false;
        this.cdr.detectChanges();
      }
    });
  }
  
  toggleScheduler(event?: any): void {
    if (this.isTogglingScheduler) {
      return;
    }
    
    this.isTogglingScheduler = true;
    // Get new state from event if available, otherwise toggle
    const newState = event?.target?.checked !== undefined ? event.target.checked : !this.schedulerEnabled;
    
    this._iotService.toggleScheduler(newState).subscribe({
      next: (response) => {
        if (response.success && response.enabled !== undefined) {
          this.schedulerEnabled = response.enabled;
        }
        this.isTogglingScheduler = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error("Error toggling scheduler:", error);
        // Revert the switch state on error
        this.schedulerEnabled = !newState;
        this.isTogglingScheduler = false;
        this.cdr.detectChanges();
      }
    });
  }

  loadGoveeDevices(): void {
    if (this.isLoadingGovee) {
      return;
    }
    
    this.isLoadingGovee = true;
    this.goveeError = '';
    this.goveeDevices = [];
    this.cdr.detectChanges();
    
    this._iotService.getAllGoveeDevicesWithStates(this.user).subscribe({
      next: (response) => {
        // If getAllDeviceStates fails or returns error, try just getting devices
        if (response.error || (response.devices && !response.deviceStates)) {
          this._iotService.getGoveeDevices(this.user).subscribe({
            next: (devicesResponse) => {
              this.goveeDevices = this.parseGoveeDevices(devicesResponse);
              this.isLoadingGovee = false;
              this.cdr.detectChanges();
            },
            error: (error) => {
              console.error("Error loading Govee devices:", error);
              this.goveeError = error.error?.message || error.message || 'Failed to load Govee devices';
              this.isLoadingGovee = false;
              this.cdr.detectChanges();
            }
          });
        } else {
          this.goveeDevices = this.parseGoveeDevices(response);
          this.isLoadingGovee = false;
          this.cdr.detectChanges();
        }
      },
      error: (error) => {
        console.error("Error loading Govee devices:", error);
        this.goveeError = error.error?.message || error.message || 'Failed to load Govee devices';
        this.isLoadingGovee = false;
        this.cdr.detectChanges();
      }
    });
  }

  parseGoveeDevices(response: any): GoveeDevice[] {
    const devices: GoveeDevice[] = [];
    
    try {
      // Check if response has error
      if (response.error || response.Unauthorized) {
        return devices;
      }

      // Try to get devices from different possible response structures
      // Priority: deviceStates first (has state data), then devices.data
      let devicesList: any[] = [];
      
      // Structure 1: response.deviceStates (from getAllDeviceStates) - HAS STATE DATA, CHECK FIRST
      if (response.deviceStates && Array.isArray(response.deviceStates)) {
        devicesList = response.deviceStates;
      }
      // Structure 2: response.devices.data (array) - Actual Govee API structure
      else if (response.devices?.data && Array.isArray(response.devices.data)) {
        devicesList = response.devices.data;
      }
      // Structure 3: response.devices.data.devices (nested)
      else if (response.devices?.data?.devices && Array.isArray(response.devices.data.devices)) {
        devicesList = response.devices.data.devices;
      }
      // Structure 4: response.data (array)
      else if (response.data && Array.isArray(response.data)) {
        devicesList = response.data;
      }
      // Structure 5: response.data.devices
      else if (response.data?.devices && Array.isArray(response.data.devices)) {
        devicesList = response.data.devices;
      }
      // Structure 6: direct array
      else if (Array.isArray(response)) {
        devicesList = response;
      }

      // Parse each device
      for (const deviceData of devicesList) {
        // Extract model from SKU if model is not available
        const model = deviceData.model || deviceData.sku || '';
        
        const device: GoveeDevice = {
          device: deviceData.device || deviceData.mac || '',
          model: model,
          deviceName: deviceData.deviceName || deviceData.name || 'Unknown Device',
          controllable: deviceData.controllable || false,
          retrievable: deviceData.retrievable || false,
          supportCmds: deviceData.supportCmds || deviceData.capabilities || []
        };
        
        // Preserve the type field from API response for device type detection
        (device as any).type = deviceData.type || '';

        // Extract state information
        let state: GoveeDeviceState = {};
        
        // Check if state is in deviceData.state
        if (deviceData.state) {
          const stateData = deviceData.state;
          
          // Check if state is already extracted (direct properties like temperature, humidity, online)
          if (stateData.temperature !== undefined || stateData.humidity !== undefined || stateData.online !== undefined) {
            // State is already in the correct format, extract it directly
            state = this.extractStateData(stateData);
          }
          // Govee API format: { "payload": { "capabilities": [...] } }
          else if (stateData.payload && stateData.payload.capabilities && Array.isArray(stateData.payload.capabilities)) {
            // Extract sensor values from capabilities array
            for (const capability of stateData.payload.capabilities) {
              const instance = capability.instance;
              if (capability.state && capability.state.value !== undefined) {
                const value = capability.state.value;
                
                // Map instance names to state properties
                if (instance === 'sensorTemperature' || instance === 'sensorTe') {
                  state.temperature = typeof value === 'number' ? value : parseFloat(value);
                } else if (instance === 'sensorHumidity' || instance === 'sensorHu') {
                  state.humidity = typeof value === 'number' ? value : parseFloat(value);
                } else if (instance === 'online') {
                  state.online = value;
                } else if (instance === 'powerState' || instance === 'power') {
                  state.powerState = value;
                } else if (instance === 'brightness') {
                  state.brightness = typeof value === 'number' ? value : parseFloat(value);
                } else if (instance === 'colorTem' || instance === 'colorTemp') {
                  state.colorTem = typeof value === 'number' ? value : parseFloat(value);
                } else if (instance === 'color') {
                  state.color = value;
                }
              }
            }
          }
          // Fallback to old format: check if state is nested in data property
          else if (stateData.data) {
            const dataObj = stateData.data;
            // Check if data has properties array
            if (dataObj.properties && Array.isArray(dataObj.properties)) {
              // Merge all properties from the array
              for (const prop of dataObj.properties) {
                Object.assign(state, this.extractStateData(prop));
              }
            } else {
              state = this.extractStateData(dataObj);
            }
          } else if (stateData.properties && Array.isArray(stateData.properties)) {
            // Properties array directly in state
            for (const prop of stateData.properties) {
              Object.assign(state, this.extractStateData(prop));
            }
          } else {
            state = this.extractStateData(stateData);
          }
        }
        // Check if capabilities contain sensor information (for thermometer devices)
        else if (deviceData.capabilities && Array.isArray(deviceData.capabilities)) {
          // Capabilities only indicate what sensors are available, not the actual values
          // Values need to be fetched via the state API
        }
        // Check if state properties are directly on deviceData
        else {
          state = this.extractStateData(deviceData);
        }

        device.state = state;
        devices.push(device);
      }
    } catch (error) {
      console.error("Error parsing Govee devices:", error);
    }

    return devices;
  }

  extractStateData(data: any): GoveeDeviceState {
    const state: GoveeDeviceState = {};
    
    // Temperature - check multiple possible field names
    if (data.temperature !== undefined && data.temperature !== null && data.temperature !== '') {
      // Handle both number and string types
      if (typeof data.temperature === 'number') {
        state.temperature = data.temperature;
      } else if (typeof data.temperature === 'string' && data.temperature !== '') {
        const parsed = parseFloat(data.temperature);
        if (!isNaN(parsed)) {
          state.temperature = parsed;
        }
      }
    } else if (data.temp !== undefined) {
      state.temperature = typeof data.temp === 'number' ? data.temp : parseFloat(data.temp);
    } else if (data.sensorTe !== undefined) {
      // Govee API sometimes uses sensorTe for temperature
      const tempValue = typeof data.sensorTe === 'number' ? data.sensorTe : parseFloat(data.sensorTe);
      if (!isNaN(tempValue)) {
        state.temperature = tempValue;
      }
    }
    
    // Humidity - check multiple possible field names
    if (data.humidity !== undefined && data.humidity !== null && data.humidity !== '') {
      // Handle both number and string types
      if (typeof data.humidity === 'number') {
        state.humidity = data.humidity;
      } else if (typeof data.humidity === 'string' && data.humidity !== '') {
        const parsed = parseFloat(data.humidity);
        if (!isNaN(parsed)) {
          state.humidity = parsed;
        }
      }
    } else if (data.hum !== undefined) {
      state.humidity = typeof data.hum === 'number' ? data.hum : parseFloat(data.hum);
    } else if (data.sensorHu !== undefined) {
      // Govee API sometimes uses sensorHu for humidity
      const humValue = typeof data.sensorHu === 'number' ? data.sensorHu : parseFloat(data.sensorHu);
      if (!isNaN(humValue)) {
        state.humidity = humValue;
      }
    }
    
    // Power state
    if (data.powerState !== undefined) {
      state.powerState = data.powerState;
    } else if (data.power !== undefined) {
      state.powerState = data.power;
    }
    
    // Brightness
    if (data.brightness !== undefined) {
      state.brightness = typeof data.brightness === 'number' ? data.brightness : parseFloat(data.brightness);
    }
    
    // Color
    if (data.color) {
      state.color = data.color;
    }
    
    // Color temperature
    if (data.colorTem !== undefined) {
      state.colorTem = typeof data.colorTem === 'number' ? data.colorTem : parseFloat(data.colorTem);
    } else if (data.colorTemp !== undefined) {
      state.colorTem = typeof data.colorTemp === 'number' ? data.colorTemp : parseFloat(data.colorTemp);
    }
    
    // Online status
    if (data.online !== undefined) {
      state.online = data.online === true || data.online === 'true';
    }

    return state;
  }

  getDeviceType(device: GoveeDevice): string {
    // Check if device has a type field (from API response)
    const deviceType = (device as any).type || '';
    if (deviceType) {
      if (deviceType.includes('thermometer')) {
        return 'IOT.THERMOMETER';
      }
      if (deviceType.includes('hygrometer')) {
        return 'Hygrometer';
      }
      if (deviceType.includes('light') || deviceType.includes('bulb') || deviceType.includes('lamp')) {
        return 'Smart Light';
      }
      if (deviceType.includes('sensor')) {
        return 'Sensor';
      }
    }
    
    // Fallback to checking model and name
    const model = device.model?.toLowerCase() || '';
    const name = device.deviceName?.toLowerCase() || '';
    
    if (model.includes('thermometer') || name.includes('thermometer') || name.includes('temp')) {
      return 'IOT.THERMOMETER';
    }
    if (model.includes('hygrometer') || name.includes('hygrometer') || name.includes('humidity')) {
      return 'Hygrometer';
    }
    if (model.includes('light') || name.includes('light') || name.includes('bulb') || name.includes('lamp')) {
      return 'Smart Light';
    }
    if (model.includes('sensor') || name.includes('sensor')) {
      return 'Sensor';
    }
    if (device.state?.temperature !== undefined || device.state?.humidity !== undefined) {
      return 'Climate Sensor';
    }
    
    return 'Smart Device';
  }

  getDeviceTypeTranslation(device: GoveeDevice): string {
    return this.getDeviceType(device);
  }

  getDeviceIcon(device: GoveeDevice): string {
    const type = this.getDeviceType(device);
    switch (type) {
      case 'IOT.THERMOMETER':
      case 'Thermometer':
      case 'Climate Sensor':
        return 'fa-thermometer-half';
      case 'Hygrometer':
        return 'fa-tint';
      case 'Smart Light':
        return 'fa-lightbulb';
      case 'Sensor':
        return 'fa-sensor';
      default:
        return 'fa-home';
    }
  }

  isStateEmpty(state: GoveeDeviceState | undefined): boolean {
    if (!state) {
      return true;
    }
    return Object.keys(state).length === 0;
  }

  hasValidTemperature(state: GoveeDeviceState | undefined): boolean {
    if (!state || state.temperature === undefined) {
      return false;
    }
    // Check if temperature is a valid number (not empty string, not null, not NaN)
    const tempValue = state.temperature;
    // Handle both number and string types
    if (typeof tempValue === 'string' && tempValue === '') {
      return false;
    }
    const temp = typeof tempValue === 'number' ? tempValue : parseFloat(String(tempValue));
    return !isNaN(temp) && temp !== null && temp !== undefined;
  }

  hasValidHumidity(state: GoveeDeviceState | undefined): boolean {
    if (!state || state.humidity === undefined) {
      return false;
    }
    // Check if humidity is a valid number (not empty string, not null, not NaN)
    const humValue = state.humidity;
    // Handle both number and string types
    if (typeof humValue === 'string' && humValue === '') {
      return false;
    }
    const hum = typeof humValue === 'number' ? humValue : parseFloat(String(humValue));
    return !isNaN(hum) && hum !== null && hum !== undefined;
  }

  formatTemperature(temp: any): string {
    if (temp === undefined || temp === null || temp === '') {
      return 'N/A';
    }
    const numTemp = typeof temp === 'number' ? temp : parseFloat(String(temp));
    if (isNaN(numTemp)) {
      return 'N/A';
    }
    // Govee API returns temperature in Fahrenheit (°F)
    // Convert to Celsius: C = (F - 32) × 5/9
    const fahrenheit = numTemp; // API value is in Fahrenheit
    const celsius = (fahrenheit - 32) * 5 / 9;
    return `<span class="temp-celsius">${celsius.toFixed(2)}°C</span>`;
  }

  formatHumidity(hum: any): string {
    if (hum === undefined || hum === null || hum === '') {
      return 'N/A';
    }
    const numHum = typeof hum === 'number' ? hum : parseFloat(String(hum));
    if (isNaN(numHum)) {
      return 'N/A';
    }
    return numHum.toFixed(2);
  }

  openOrCLosePortail(): void {
    // Empêcher les clics multiples
    if (this.isLoadingPortail) {
      return;
    }
    
    // Désactiver immédiatement le bouton et afficher l'état de chargement
    this.isLoadingPortail = true;
    this.messageVisible = false;
    this.iotResponse = '';
    this.cdr.detectChanges(); // Force update pour afficher le spinner immédiatement
    
    this._iotService.openOrClosePortail(this.user).subscribe({
      next: (response) => {
        console.log("Response from Portail : " + JSON.stringify(response));
        
        // Extract the message from the JSON response
        let responseData = response;
        if (response._body) {
          responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
        }
        
        // Mettre à jour les données AVANT de changer les flags
        this.iotResponse = responseData.Arduino || responseData.message || JSON.stringify(responseData);
        
        // Mettre à jour les flags et forcer l'affichage immédiat
        this.isLoadingPortail = false;
        this.messageVisible = true;
        
        // Force immediate UI update pour afficher le résultat dès la réception
        requestAnimationFrame(() => {
          this.cdr.detectChanges();
        });

        // Masquer le message après 25 secondes (25 000 ms)
        setTimeout(() => {
          this.messageVisible = false;
          this.iotResponse = '';
          this.cdr.detectChanges();
        }, 25000);
      },
      error: (error) => {
        console.error("Error from Portail:", error);
        
        // En cas d'erreur, extraire le message d'erreur
        let errorMessage = 'Erreur lors de la communication avec le portail';
        if (error.error) {
          if (typeof error.error === 'string') {
            errorMessage = error.error;
          } else if (error.error.message) {
            errorMessage = error.error.message;
          } else if (error.error.Arduino) {
            errorMessage = error.error.Arduino;
          }
        } else if (error.message) {
          errorMessage = error.message;
        }
        
        // Mettre à jour les données AVANT de changer les flags
        this.iotResponse = errorMessage;
        
        // Mettre à jour les flags et forcer l'affichage immédiat
        this.isLoadingPortail = false;
        this.messageVisible = true;
        
        // Force immediate UI update pour afficher l'erreur dès la réception
        requestAnimationFrame(() => {
          this.cdr.detectChanges();
        });

        // Masquer le message après 21 secondes (21 000 ms)
        setTimeout(() => {
          this.messageVisible = false;
          this.iotResponse = '';
          this.cdr.detectChanges();
        }, 21000);
      }
    });
  }

  testEthernetShield(): void {
    // Empêcher les clics multiples
    if (this.isLoadingTest) {
      return;
    }
    
    // Désactiver immédiatement le bouton et afficher l'état de chargement
    this.isLoadingTest = true;
    this.messageTestVisible = false;
    this.iotTestResponse = '';
    this.cdr.detectChanges(); // Force update pour afficher le spinner immédiatement
    
    this._iotService.testEThernetShield(this.user).subscribe({
      next: (response) => {
        console.log("Response from Arduino : " + JSON.stringify(response));
        
        // Extract the Arduino message from the JSON response
        let responseData = response;
        if (response._body) {
          responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
        }
        
        // Mettre à jour les données AVANT de changer les flags
        this.iotTestResponse = responseData.Arduino || JSON.stringify(responseData);
        
        // Mettre à jour les flags et forcer l'affichage immédiat
        this.isLoadingTest = false;
        this.messageTestVisible = true;
        
        // Force immediate UI update pour afficher le résultat dès la réception
        requestAnimationFrame(() => {
          this.cdr.detectChanges();
        });

        // Masquer le message après 3 secondes (3 000 ms)
        setTimeout(() => {
          this.messageTestVisible = false;
          this.iotTestResponse = '';
          this.cdr.detectChanges();
        }, 3000);
      },
      error: (error) => {
        console.error("Error from Arduino:", error);
        
        // En cas d'erreur, extraire le message d'erreur
        let errorMessage = 'Erreur lors du test de l\'Ethernet Shield';
        if (error.error) {
          if (typeof error.error === 'string') {
            errorMessage = error.error;
          } else if (error.error.message) {
            errorMessage = error.error.message;
          } else if (error.error.Arduino) {
            errorMessage = error.error.Arduino;
          }
        } else if (error.message) {
          errorMessage = error.message;
        }
        
        // Mettre à jour les données AVANT de changer les flags
        this.iotTestResponse = errorMessage;
        
        // Mettre à jour les flags et forcer l'affichage immédiat
        this.isLoadingTest = false;
        this.messageTestVisible = true;
        
        // Force immediate UI update pour afficher l'erreur dès la réception
        requestAnimationFrame(() => {
          this.cdr.detectChanges();
        });

        // Masquer le message après 5 secondes (5 000 ms)
        setTimeout(() => {
          this.messageTestVisible = false;
          this.iotTestResponse = '';
          this.cdr.detectChanges();
        }, 5000);
      }
    });
  }

  loadAllThermometerHistory(): void {
    if (this.isLoadingHistory) {
      return;
    }
    
    this.isLoadingHistory = true;
    this.historyError = '';
    this.selectedDeviceId = '';
    this.cdr.detectChanges();
    
    // Load all history (no deviceId)
    this._iotService.getThermometerHistory('').subscribe({
      next: (response) => {
        if (response.error) {
          this.historyError = response.error;
          this.thermometerHistoryByDevice = new Map();
          this.showHistoryChart = false;
        } else if (response.historyByDevice) {
          // Convert historyByDevice object to Map
          this.thermometerHistoryByDevice = new Map();
          this.deviceColors = new Map();
          
          const deviceIds = Object.keys(response.historyByDevice);
          deviceIds.forEach((deviceId, index) => {
            const history = response.historyByDevice[deviceId];
            this.thermometerHistoryByDevice.set(deviceId, history);
            // Assign color to device
            this.deviceColors.set(deviceId, this.colorPalette[index % this.colorPalette.length]);
          });
          
          // Update chart data
          this.updateChartData();
          
          // Initialize toggle states
          this.initializeToggleStates();
          
          this.showHistoryChart = true;
        } else {
          this.thermometerHistoryByDevice = new Map();
          this.showHistoryChart = false;
        }
        this.isLoadingHistory = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error("Error loading thermometer history:", error);
        this.historyError = error.error?.error || error.error?.message || error.message || 'Failed to load history';
        this.thermometerHistoryByDevice = new Map();
        this.showHistoryChart = false;
        this.isLoadingHistory = false;
        this.cdr.detectChanges();
      }
    });
  }

  loadThermometerHistory(deviceId: string): void {
    // This method is kept for backwards compatibility but not used anymore
    this.loadAllThermometerHistory();
  }

  refreshThermometers(): void {
    if (this.isRefreshingThermometers) {
      return;
    }
    
    this.isRefreshingThermometers = true;
    this.cdr.detectChanges();
    
    this._iotService.refreshThermometers(this.user).subscribe({
      next: (response) => {
        console.log("Thermometers refreshed:", response);
        // Reload devices after refresh
        this.loadGoveeDevices();
        this.isRefreshingThermometers = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error("Error refreshing thermometers:", error);
        this.isRefreshingThermometers = false;
        this.cdr.detectChanges();
      }
    });
  }

  clearThermometerHistory(): void {
    if (this.isClearingHistory) {
      return;
    }
    
    if (!confirm('Êtes-vous sûr de vouloir supprimer l\'historique de tous les thermomètres ?')) {
      return;
    }
    
    this.isClearingHistory = true;
    this.cdr.detectChanges();
    
    // Clear all history (no deviceId)
    this._iotService.clearThermometerHistory().subscribe({
      next: (response) => {
        console.log("History cleared:", response);
        // Clear all local history
        this.thermometerHistoryByDevice = new Map();
        this.thermometerHistory = [];
        this.showHistoryChart = false;
        this.isClearingHistory = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error("Error clearing history:", error);
        this.isClearingHistory = false;
        this.cdr.detectChanges();
      }
    });
  }

  closeHistoryChart(): void {
    this.showHistoryChart = false;
    this.selectedDeviceId = '';
    this.thermometerHistory = [];
    this.thermometerHistoryByDevice = new Map();
  }

  // Check if device is a thermometer
  isThermometer(device: GoveeDevice): boolean {
    return this.hasValidTemperature(device.state) || this.hasValidHumidity(device.state) ||
           this.getDeviceType(device) === 'IOT.THERMOMETER' ||
           (device as any).type?.toLowerCase().includes('thermometer');
  }

  // Generate SVG path for temperature chart
  generateTemperatureChartPath(): string {
    if (!this.thermometerHistory || this.thermometerHistory.length === 0) {
      return '';
    }
    
    const width = 800;
    const height = 400;
    const padding = 40;
    const chartWidth = width - 2 * padding;
    const chartHeight = height - 2 * padding;
    
    // Find min/max temperature for scaling
    let minTemp = Infinity;
    let maxTemp = -Infinity;
    
    this.thermometerHistory.forEach((entry: any) => {
      if (entry.temperature != null) {
        const temp = typeof entry.temperature === 'number' ? entry.temperature : parseFloat(entry.temperature);
        if (!isNaN(temp)) {
          minTemp = Math.min(minTemp, temp);
          maxTemp = Math.max(maxTemp, temp);
        }
      }
    });
    
    // Add some padding
    const tempRange = maxTemp - minTemp || 1;
    minTemp = minTemp - tempRange * 0.1;
    maxTemp = maxTemp + tempRange * 0.1;
    
    // Generate path
    let path = '';
    const points: string[] = [];
    
    this.thermometerHistory.forEach((entry: any, index: number) => {
      if (entry.temperature != null) {
        const temp = typeof entry.temperature === 'number' ? entry.temperature : parseFloat(entry.temperature);
        if (!isNaN(temp)) {
          const x = padding + (index / (this.thermometerHistory.length - 1 || 1)) * chartWidth;
          const y = padding + chartHeight - ((temp - minTemp) / (maxTemp - minTemp || 1)) * chartHeight;
          points.push(`${x},${y}`);
        }
      }
    });
    
    if (points.length > 0) {
      path = `M ${points.join(' L ')}`;
    }
    
    return path;
  }

  // Generate SVG path for humidity chart
  generateHumidityChartPath(): string {
    if (!this.thermometerHistory || this.thermometerHistory.length === 0) {
      return '';
    }
    
    const width = 800;
    const height = 400;
    const padding = 40;
    const chartWidth = width - 2 * padding;
    const chartHeight = height - 2 * padding;
    
    // Find min/max humidity for scaling
    let minHum = 0;
    let maxHum = 100;
    
    this.thermometerHistory.forEach((entry: any) => {
      if (entry.humidity != null) {
        const hum = typeof entry.humidity === 'number' ? entry.humidity : parseFloat(entry.humidity);
        if (!isNaN(hum)) {
          minHum = Math.min(minHum, hum);
          maxHum = Math.max(maxHum, hum);
        }
      }
    });
    
    // Add some padding
    const humRange = maxHum - minHum || 100;
    minHum = Math.max(0, minHum - humRange * 0.1);
    maxHum = Math.min(100, maxHum + humRange * 0.1);
    
    // Generate path
    let path = '';
    const points: string[] = [];
    
    this.thermometerHistory.forEach((entry: any, index: number) => {
      if (entry.humidity != null) {
        const hum = typeof entry.humidity === 'number' ? entry.humidity : parseFloat(entry.humidity);
        if (!isNaN(hum)) {
          const x = padding + (index / (this.thermometerHistory.length - 1 || 1)) * chartWidth;
          const y = padding + chartHeight - ((hum - minHum) / (maxHum - minHum || 1)) * chartHeight;
          points.push(`${x},${y}`);
        }
      }
    });
    
    if (points.length > 0) {
      path = `M ${points.join(' L ')}`;
    }
    
    return path;
  }

  // Format timestamp for display
  formatTimestamp(timestamp: string): string {
    if (!timestamp) return '';
    try {
      const date = new Date(timestamp);
      return date.toLocaleString('fr-FR', { 
        day: '2-digit', 
        month: '2-digit', 
        year: 'numeric',
        hour: '2-digit', 
        minute: '2-digit' 
      });
    } catch {
      return timestamp;
    }
  }

  // Get min temperature from history
  getMinTemperature(): number {
    if (!this.thermometerHistory || this.thermometerHistory.length === 0) {
      return 0;
    }
    let min = Infinity;
    this.thermometerHistory.forEach((entry: any) => {
      if (entry.temperature != null) {
        const temp = typeof entry.temperature === 'number' ? entry.temperature : parseFloat(entry.temperature);
        if (!isNaN(temp)) {
          min = Math.min(min, temp);
        }
      }
    });
    return isFinite(min) ? min : 0;
  }

  // Get max temperature from history
  getMaxTemperature(): number {
    if (!this.thermometerHistory || this.thermometerHistory.length === 0) {
      return 100;
    }
    let max = -Infinity;
    this.thermometerHistory.forEach((entry: any) => {
      if (entry.temperature != null) {
        const temp = typeof entry.temperature === 'number' ? entry.temperature : parseFloat(entry.temperature);
        if (!isNaN(temp)) {
          max = Math.max(max, temp);
        }
      }
    });
    return isFinite(max) ? max : 100;
  }

  // Get last 10 history entries for display
  getLast10HistoryEntries(): any[] {
    if (!this.thermometerHistory || this.thermometerHistory.length === 0) {
      return [];
    }
    // Return last 10 entries, in reverse order (newest first)
    return this.thermometerHistory.slice(-10).reverse();
  }

  // Get device color
  getDeviceColor(deviceId: string): string {
    return this.deviceColors.get(deviceId) || '#000000';
  }

  // Get device name from deviceId
  getDeviceName(deviceId: string): string {
    const device = this.goveeDevices.find(d => d.device === deviceId);
    return device ? device.deviceName : deviceId;
  }

  // Get min/max temperature across all devices
  getAllMinMaxTemperature(): { min: number, max: number } {
    let minTemp = Infinity;
    let maxTemp = -Infinity;

    this.thermometerHistoryByDevice.forEach((history: any[]) => {
      history.forEach((entry: any) => {
        if (entry.temperature != null) {
          const temp = typeof entry.temperature === 'number' ? entry.temperature : parseFloat(entry.temperature);
          if (!isNaN(temp)) {
            minTemp = Math.min(minTemp, temp);
            maxTemp = Math.max(maxTemp, temp);
          }
        }
      });
    });

    if (!isFinite(minTemp) || !isFinite(maxTemp)) {
      return { min: 0, max: 100 };
    }

    // Add some padding
    const tempRange = maxTemp - minTemp || 1;
    minTemp = minTemp - tempRange * 0.1;
    maxTemp = maxTemp + tempRange * 0.1;

    return { min: minTemp, max: maxTemp };
  }

  // Generate SVG path for temperature chart for a specific device
  generateDeviceTemperaturePath(deviceId: string): string {
    const history = this.thermometerHistoryByDevice.get(deviceId);
    if (!history || history.length === 0) {
      return '';
    }

    const width = 800;
    const height = 400;
    const padding = 40;
    const chartWidth = width - 2 * padding;
    const chartHeight = height - 2 * padding;

    const { min, max } = this.getAllMinMaxTemperature();
    const tempRange = max - min || 1;

    // Generate path
    const points: string[] = [];

    history.forEach((entry: any, index: number) => {
      if (entry.temperature != null) {
        const temp = typeof entry.temperature === 'number' ? entry.temperature : parseFloat(entry.temperature);
        if (!isNaN(temp)) {
          const x = padding + (index / (history.length - 1 || 1)) * chartWidth;
          const y = padding + chartHeight - ((temp - min) / tempRange) * chartHeight;
          points.push(`${x},${y}`);
        }
      }
    });

    if (points.length > 0) {
      return `M ${points.join(' L ')}`;
    }

    return '';
  }

  // Get min/max humidity across all devices (0-100)
  getAllMinMaxHumidity(): { min: number, max: number } {
    let minHum = 0;
    let maxHum = 100;

    this.thermometerHistoryByDevice.forEach((history: any[]) => {
      history.forEach((entry: any) => {
        if (entry.humidity != null) {
          const hum = typeof entry.humidity === 'number' ? entry.humidity : parseFloat(entry.humidity);
          if (!isNaN(hum)) {
            minHum = Math.min(minHum, hum);
            maxHum = Math.max(maxHum, hum);
          }
        }
      });
    });

    // Add some padding
    const humRange = maxHum - minHum || 100;
    minHum = Math.max(0, minHum - humRange * 0.1);
    maxHum = Math.min(100, maxHum + humRange * 0.1);

    return { min: minHum, max: maxHum };
  }

  // Generate SVG path for humidity chart for a specific device
  generateDeviceHumidityPath(deviceId: string): string {
    const history = this.thermometerHistoryByDevice.get(deviceId);
    if (!history || history.length === 0) {
      return '';
    }

    const width = 800;
    const height = 400;
    const padding = 40;
    const chartWidth = width - 2 * padding;
    const chartHeight = height - 2 * padding;

    // Use the same min/max as temperature to align scales
    // But we'll map humidity (0-100%) to the same visual range
    const { min: tempMin, max: tempMax } = this.getAllMinMaxTemperature();
    const tempRange = tempMax - tempMin || 1;
    
    // Map humidity to temperature scale (0-100% humidity maps to temp range)
    const { min: humMin, max: humMax } = this.getAllMinMaxHumidity();
    const humRange = humMax - humMin || 1;

    // Generate path
    const points: string[] = [];

    history.forEach((entry: any, index: number) => {
      if (entry.humidity != null) {
        const hum = typeof entry.humidity === 'number' ? entry.humidity : parseFloat(entry.humidity);
        if (!isNaN(hum)) {
          const x = padding + (index / (history.length - 1 || 1)) * chartWidth;
          // Map humidity to the same visual scale as temperature
          // Normalize humidity first (0-1), then map to temp range
          const normalizedHum = (hum - humMin) / humRange;
          const mappedHum = tempMin + (normalizedHum * tempRange);
          const y = padding + chartHeight - ((mappedHum - tempMin) / tempRange) * chartHeight;
          points.push(`${x},${y}`);
        }
      }
    });

    if (points.length > 0) {
      return `M ${points.join(' L ')}`;
    }

    return '';
  }

  // Update Chart.js data with all devices history
  updateChartData(): void {
    if (!this.thermometerHistoryByDevice || this.thermometerHistoryByDevice.size === 0) {
      this.lineChartData = {
        datasets: [],
        labels: []
      };
      return;
    }

    // Collect all unique timestamps to create labels
    // Round timestamps to the nearest second to avoid duplicates
    const allTimestamps: Date[] = [];
    this.thermometerHistoryByDevice.forEach((history: any[]) => {
      history.forEach((entry: any) => {
        if (entry.timestamp) {
          const date = new Date(entry.timestamp);
          if (!isNaN(date.getTime())) {
            // Round to nearest second (remove milliseconds)
            const roundedTime = Math.floor(date.getTime() / 1000) * 1000;
            allTimestamps.push(new Date(roundedTime));
          }
        }
      });
    });

    // Sort and get unique timestamps (by second, not millisecond)
    const uniqueTimestamps = Array.from(new Set(allTimestamps.map(d => d.getTime())))
      .map(time => new Date(time))
      .sort((a, b) => a.getTime() - b.getTime());

    // Format labels for display
    const labels = uniqueTimestamps.map(date => 
      date.toLocaleString('fr-FR', { 
        day: '2-digit', 
        month: '2-digit',
        hour: '2-digit', 
        minute: '2-digit',
        second: '2-digit'
      })
    );

    // Create datasets for each device
    const datasets: any[] = [];
    
    this.thermometerHistoryByDevice.forEach((history: any[], deviceId: string) => {
      const deviceColor = this.deviceColors.get(deviceId) || '#000000';
      const deviceName = this.getDeviceName(deviceId);

      // Temperature dataset - use forward fill to avoid gaps
      let lastKnownTemp: number | null = null;
      const tempData = uniqueTimestamps.map(timestamp => {
        // Find the closest entry within a reasonable time window (5 minutes)
        const timeWindow = 5 * 60 * 1000; // 5 minutes in milliseconds
        let closestEntry: any = null;
        let closestDistance = Infinity;
        
        history.forEach((e: any) => {
          if (!e.timestamp || e.temperature == null) return;
          const entryDate = new Date(e.timestamp);
          const roundedEntryTime = Math.floor(entryDate.getTime() / 1000) * 1000;
          const distance = Math.abs(roundedEntryTime - timestamp.getTime());
          
          if (distance < timeWindow && distance < closestDistance) {
            closestDistance = distance;
            closestEntry = e;
          }
        });
        
        if (closestEntry?.temperature != null) {
          lastKnownTemp = parseFloat(closestEntry.temperature);
          return lastKnownTemp;
        }
        
        // Use last known value if available (forward fill)
        return lastKnownTemp;
      });

      // For scatter chart, data must be in [x, y] format
      const tempDataFormatted = this.selectedChartType === 'scatter' 
        ? uniqueTimestamps.map((timestamp, index) => ({
            x: timestamp.getTime(), // Use timestamp in milliseconds for x
            y: tempData[index] // y value
          }))
        : tempData;

      // Adjust opacity based on chart type: more opaque for bars, less for lines
      const backgroundColorOpacity = this.selectedChartType === 'bar' ? 'CC' : '20'; // CC = ~80% opacity, 20 = ~12% opacity
      
      datasets.push({
        label: `${deviceName} - Température (°C)`,
        data: tempDataFormatted as any,
        borderColor: deviceColor,
        backgroundColor: deviceColor + backgroundColorOpacity,
        yAxisID: 'y',
        tension: 0.4,
        fill: false,
        pointRadius: 2,
        pointHoverRadius: 5
      });

      // Humidity dataset - use forward fill to avoid gaps
      let lastKnownHum: number | null = null;
      const humData = uniqueTimestamps.map(timestamp => {
        // Find the closest entry within a reasonable time window (5 minutes)
        const timeWindow = 5 * 60 * 1000; // 5 minutes in milliseconds
        let closestEntry: any = null;
        let closestDistance = Infinity;
        
        history.forEach((e: any) => {
          if (!e.timestamp || e.humidity == null) return;
          const entryDate = new Date(e.timestamp);
          const roundedEntryTime = Math.floor(entryDate.getTime() / 1000) * 1000;
          const distance = Math.abs(roundedEntryTime - timestamp.getTime());
          
          if (distance < timeWindow && distance < closestDistance) {
            closestDistance = distance;
            closestEntry = e;
          }
        });
        
        if (closestEntry?.humidity != null) {
          lastKnownHum = parseFloat(closestEntry.humidity);
          return lastKnownHum;
        }
        
        // Use last known value if available (forward fill)
        return lastKnownHum;
      });

      // For scatter chart, data must be in [x, y] format
      const humDataFormatted = this.selectedChartType === 'scatter'
        ? uniqueTimestamps.map((timestamp, index) => ({
            x: timestamp.getTime(), // Use timestamp in milliseconds for x
            y: humData[index] // y value
          }))
        : humData;

      datasets.push({
        label: `${deviceName} - Humidité (%)`,
        data: humDataFormatted as any,
        borderColor: deviceColor,
        backgroundColor: deviceColor + backgroundColorOpacity,
        yAxisID: 'y1',
        tension: 0.4,
        fill: false,
        borderDash: [5, 5],
        pointRadius: 2,
        pointHoverRadius: 5,
        pointStyle: 'circle'
      });
    });

    // For scatter chart, we need to configure x-axis differently
    if (this.selectedChartType === 'scatter') {
      // Update x-axis to use linear scale with time formatting
      this.lineChartOptions.scales = {
        ...this.lineChartOptions.scales,
        x: {
          type: 'linear',
          display: true,
          title: {
            display: true,
            text: 'Temps'
          },
          ticks: {
            callback: function(value: any) {
              // Convert timestamp (milliseconds) back to date string
              const date = new Date(value);
              return date.toLocaleString('fr-FR', { 
                day: '2-digit', 
                month: '2-digit',
                hour: '2-digit', 
                minute: '2-digit',
                second: '2-digit'
              });
            }
          }
        }
      };
    } else {
      // For line and bar charts, use default x-axis with labels
      this.lineChartOptions.scales = {
        ...this.lineChartOptions.scales,
        x: {
          display: true,
          title: {
            display: true,
            text: 'Temps'
          }
        }
      };
    }

    this.lineChartData = {
      labels: this.selectedChartType === 'scatter' ? [] : labels, // No labels for scatter
      datasets: datasets as ChartConfiguration<'line' | 'bar' | 'scatter'>['data']['datasets']
    };

    // Restore visibility state after data update
    setTimeout(() => {
      if (this.chart?.chart) {
        const chart = this.chart.chart;
        chart.data.datasets.forEach((dataset, index) => {
          const label = dataset.label || '';
          if (this.datasetVisibilityState.has(label)) {
            const shouldBeHidden = this.datasetVisibilityState.get(label) === false;
            const meta = chart.getDatasetMeta(index);
            meta.hidden = shouldBeHidden;
          }
        });
        
        // Update toggle states based on current visibility
        this.updateToggleStates();
        
        // Force change detection after updating toggle states
        this.cdr.detectChanges();
        
        chart.update();
      }
    }, 0);
  }
  
  // Update toggle states based on current chart visibility
  updateToggleStates(): void {
    if (!this.chart?.chart) {
      return;
    }
    
    const chart = this.chart.chart;
    let allVisible = true;
    let anyTempVisible = false;
    let anyHumVisible = false;
    
    chart.data.datasets.forEach((dataset, index) => {
      const label = dataset.label || '';
      const meta = chart.getDatasetMeta(index);
      const isVisible = !meta.hidden;
      
      if (!isVisible) {
        allVisible = false;
      }
      
      if (label.includes('Température') && isVisible) {
        anyTempVisible = true;
      }
      
      if (label.includes('Humidité') && isVisible) {
        anyHumVisible = true;
      }
    });
    
    // Use setTimeout to update values in next tick to avoid ExpressionChangedAfterItHasBeenCheckedError
    setTimeout(() => {
      this.allLinesVisible = allVisible;
      this.temperaturesVisible = anyTempVisible;
      this.humiditiesVisible = anyHumVisible;
      this.cdr.detectChanges();
    }, 0);
  }
  
  // Initialize toggle states when chart is first loaded
  initializeToggleStates(): void {
    this.allLinesVisible = true;
    this.temperaturesVisible = true;
    this.humiditiesVisible = true;
  }

  // Handle chart type change
  onChartTypeChange(): void {
    // Rebuild chart data with correct format for the selected type
    this.updateChartData();
  }

  // Hide all lines/charts
  hideAllLines(): void {
    if (!this.chart) {
      return;
    }
    
    const chart = this.chart.chart;
    if (!chart) {
      return;
    }
    
    // Hide all datasets and save state
    chart.data.datasets.forEach((dataset, index) => {
      const meta = chart.getDatasetMeta(index);
      const label = dataset.label || '';
      meta.hidden = true;
      this.datasetVisibilityState.set(label, false); // false = hidden
    });
    
    chart.update();
  }

  // Show all lines/charts
  showAllLines(): void {
    if (!this.chart) {
      return;
    }
    
    const chart = this.chart.chart;
    if (!chart) {
      return;
    }
    
    // Show all datasets and save state
    chart.data.datasets.forEach((dataset, index) => {
      const meta = chart.getDatasetMeta(index);
      const label = dataset.label || '';
      meta.hidden = false;
      this.datasetVisibilityState.set(label, true); // true = visible
    });
    
    chart.update();
  }

  // Hide only temperature datasets
  hideTemperatures(): void {
    if (!this.chart) {
      return;
    }
    
    const chart = this.chart.chart;
    if (!chart) {
      return;
    }
    
    chart.data.datasets.forEach((dataset, index) => {
      const label = dataset.label || '';
      if (label.includes('Température')) {
        const meta = chart.getDatasetMeta(index);
        meta.hidden = true;
        this.datasetVisibilityState.set(label, false); // false = hidden
      }
    });
    
    chart.update();
  }

  // Show only temperature datasets
  showTemperatures(): void {
    if (!this.chart) {
      return;
    }
    
    const chart = this.chart.chart;
    if (!chart) {
      return;
    }
    
    chart.data.datasets.forEach((dataset, index) => {
      const label = dataset.label || '';
      if (label.includes('Température')) {
        const meta = chart.getDatasetMeta(index);
        meta.hidden = false;
        this.datasetVisibilityState.set(label, true); // true = visible
      }
    });
    
    chart.update();
  }

  // Hide only humidity datasets
  hideHumidities(): void {
    if (!this.chart) {
      return;
    }
    
    const chart = this.chart.chart;
    if (!chart) {
      return;
    }
    
    chart.data.datasets.forEach((dataset, index) => {
      const label = dataset.label || '';
      if (label.includes('Humidité')) {
        const meta = chart.getDatasetMeta(index);
        meta.hidden = true;
        this.datasetVisibilityState.set(label, false); // false = hidden
      }
    });
    
    chart.update();
  }

  // Show only humidity datasets
  showHumidities(): void {
    if (!this.chart) {
      return;
    }
    
    const chart = this.chart.chart;
    if (!chart) {
      return;
    }
    
    chart.data.datasets.forEach((dataset, index) => {
      const label = dataset.label || '';
      if (label.includes('Humidité')) {
        const meta = chart.getDatasetMeta(index);
        meta.hidden = false;
        this.datasetVisibilityState.set(label, true); // true = visible
      }
    });
    
    chart.update();
  }

  // Toggle all lines visibility
  toggleAllLines(): void {
    if (!this.chart?.chart) {
      return;
    }
    
    // Check current state - if all are visible, hide them; otherwise show them
    const chart = this.chart.chart;
    let allVisible = true;
    
    chart.data.datasets.forEach((dataset, index) => {
      const meta = chart.getDatasetMeta(index);
      if (meta.hidden) {
        allVisible = false;
      }
    });
    
    if (allVisible) {
      this.hideAllLines();
      this.allLinesVisible = false;
    } else {
      this.showAllLines();
      this.allLinesVisible = true;
    }
    
    // Update toggle states
    this.updateToggleStates();
  }

  // Toggle temperatures visibility
  toggleTemperatures(): void {
    if (!this.chart?.chart) {
      return;
    }
    
    // Check if any temperature dataset is visible
    const chart = this.chart.chart;
    let anyTempVisible = false;
    
    chart.data.datasets.forEach((dataset, index) => {
      const label = dataset.label || '';
      if (label.includes('Température')) {
        const meta = chart.getDatasetMeta(index);
        if (!meta.hidden) {
          anyTempVisible = true;
        }
      }
    });
    
    if (anyTempVisible) {
      this.hideTemperatures();
    } else {
      this.showTemperatures();
    }
    
    // Update toggle states
    this.updateToggleStates();
  }

  // Toggle humidities visibility
  toggleHumidities(): void {
    if (!this.chart?.chart) {
      return;
    }
    
    // Check if any humidity dataset is visible
    const chart = this.chart.chart;
    let anyHumVisible = false;
    
    chart.data.datasets.forEach((dataset, index) => {
      const label = dataset.label || '';
      if (label.includes('Humidité')) {
        const meta = chart.getDatasetMeta(index);
        if (!meta.hidden) {
          anyHumVisible = true;
        }
      }
    });
    
    if (anyHumVisible) {
      this.hideHumidities();
    } else {
      this.showHumidities();
    }
    
    // Update toggle states
    this.updateToggleStates();
  }

  // Refresh thermometers from modal (and reload history)
  refreshThermometersInModal(): void {
    if (this.isRefreshingThermometers) {
      return;
    }
    
    this.isRefreshingThermometers = true;
    this.cdr.detectChanges();
    
    this._iotService.refreshThermometers(this.user).subscribe({
      next: (response) => {
        console.log("Thermometers refreshed from modal:", response);
        // Reload history after refresh
        this.loadAllThermometerHistory();
        this.isRefreshingThermometers = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error("Error refreshing thermometers from modal:", error);
        this.isRefreshingThermometers = false;
        this.cdr.detectChanges();
      }
    });
  }

}
