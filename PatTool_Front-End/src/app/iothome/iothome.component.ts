import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { Member } from '../model/member';
import { IotService } from '../services/iot.service';
import { MembersService } from '../services/members.service';

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
  imports: [CommonModule, TranslateModule, NavigationButtonsModule]
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

  constructor(
    private _memberService: MembersService, 
    private _iotService: IotService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit() {
    this.loadGoveeDevices();
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
        console.log("Govee devices response: ", response);
        // If getAllDeviceStates fails or returns error, try just getting devices
        if (response.error || (response.devices && !response.deviceStates)) {
          console.log("State fetch failed or incomplete, trying to get just devices");
          this._iotService.getGoveeDevices(this.user).subscribe({
            next: (devicesResponse) => {
              console.log("Govee devices only response: ", devicesResponse);
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
        console.log("Using deviceStates array (has state data)");
      }
      // Structure 2: response.devices.data (array) - Actual Govee API structure
      else if (response.devices?.data && Array.isArray(response.devices.data)) {
        devicesList = response.devices.data;
        console.log("Using devices.data array");
      }
      // Structure 3: response.devices.data.devices (nested)
      else if (response.devices?.data?.devices && Array.isArray(response.devices.data.devices)) {
        devicesList = response.devices.data.devices;
        console.log("Using devices.data.devices array");
      }
      // Structure 4: response.data (array)
      else if (response.data && Array.isArray(response.data)) {
        devicesList = response.data;
        console.log("Using data array");
      }
      // Structure 5: response.data.devices
      else if (response.data?.devices && Array.isArray(response.data.devices)) {
        devicesList = response.data.devices;
        console.log("Using data.devices array");
      }
      // Structure 6: direct array
      else if (Array.isArray(response)) {
        devicesList = response;
        console.log("Using direct array");
      }
      
      console.log("Parsed devices list:", devicesList);

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
          console.log("State data for device:", deviceData.deviceName, stateData);
          
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
          console.log("Device has capabilities:", deviceData.capabilities);
          // Capabilities only indicate what sensors are available, not the actual values
          // Values need to be fetched via the state API
        }
        // Check if state properties are directly on deviceData
        else {
          state = this.extractStateData(deviceData);
        }
        
        console.log("Extracted state for device:", deviceData.deviceName, state);
        console.log("State object keys:", Object.keys(state));
        console.log("Temperature value:", state.temperature, "Type:", typeof state.temperature);
        console.log("Humidity value:", state.humidity, "Type:", typeof state.humidity);
        console.log("Online value:", state.online, "Type:", typeof state.online);
        console.log("hasValidTemperature result:", this.hasValidTemperature(state));
        console.log("hasValidHumidity result:", this.hasValidHumidity(state));

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

}
