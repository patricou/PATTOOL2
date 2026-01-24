import { Component, OnInit, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import { ApiService } from '../services/api.service';

@Component({
  selector: 'app-openweathermap',
  templateUrl: './openweathermap.component.html',
  styleUrls: ['./openweathermap.component.css'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NavigationButtonsModule, TraceViewerModalComponent]
})
export class OpenWeatherMapComponent implements OnInit {

  @ViewChild(TraceViewerModalComponent) traceViewerModalComponent?: TraceViewerModalComponent;

  // OpenWeatherMap data
  city: string = 'Paris';
  countryCode: string = 'FR';
  lat: number = 48.8566;
  lon: number = 2.3522;
  
  currentWeather: any = null;
  forecast: any = null;
  apiStatus: any = null;
  
  isLoadingCurrentWeather: boolean = false;
  isLoadingForecast: boolean = false;
  isLoadingStatus: boolean = false;
  
  errorMessage: string = '';
  successMessage: string = '';
  private weatherFetchTimeout?: number;

  constructor(
    private apiService: ApiService,
    private translateService: TranslateService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadApiStatus();
    this.loadUserLocation();
  }

  /**
   * Load API status
   */
  loadApiStatus(): void {
    this.isLoadingStatus = true;
    this.errorMessage = '';
    
    this.apiService.getApiStatus().subscribe({
      next: (response) => {
        this.apiStatus = response;
        this.isLoadingStatus = false;
      },
      error: (error) => {
        console.error('Error loading API status:', error);
        this.errorMessage = 'Error loading API status: ' + (error.message || 'Unknown error');
        this.isLoadingStatus = false;
      }
    });
  }

  /**
   * Get current weather for city
   */
  getCurrentWeather(): void {
    if (!this.city || this.city.trim() === '') {
      this.errorMessage = 'Please enter a city name';
      return;
    }

    this.isLoadingCurrentWeather = true;
    this.errorMessage = '';
    this.currentWeather = null;

    this.apiService.getCurrentWeather(this.city, this.countryCode || undefined).subscribe({
      next: (response) => {
        if (response.error) {
          this.errorMessage = response.error;
        } else {
          this.currentWeather = response;
          this.successMessage = `Weather data loaded for ${response.name || this.city}`;
        }
        this.isLoadingCurrentWeather = false;
      },
      error: (error) => {
        console.error('Error fetching current weather:', error);
        this.errorMessage = 'Error fetching weather: ' + (error.error?.message || error.message || 'Unknown error');
        this.isLoadingCurrentWeather = false;
      }
    });
  }

  /**
   * Get current weather by coordinates
   */
  getCurrentWeatherByCoordinates(): void {
    this.isLoadingCurrentWeather = true;
    this.errorMessage = '';
    this.currentWeather = null;

    this.apiService.getCurrentWeatherByCoordinates(this.lat, this.lon).subscribe({
      next: (response) => {
        if (response.error) {
          this.errorMessage = response.error;
        } else {
          this.currentWeather = response;
          this.city = response.name || this.city;
          // Use setTimeout to update successMessage asynchronously to avoid ExpressionChangedAfterItHasBeenCheckedError
          setTimeout(() => {
            this.successMessage = `Weather data loaded for coordinates (${this.lat}, ${this.lon})`;
            this.cdr.markForCheck();
          }, 0);
        }
        this.isLoadingCurrentWeather = false;
        this.cdr.markForCheck();
      },
      error: (error) => {
        console.error('Error fetching current weather by coordinates:', error);
        this.errorMessage = 'Error fetching weather: ' + (error.error?.message || error.message || 'Unknown error');
        this.isLoadingCurrentWeather = false;
      }
    });
  }

  /**
   * Get forecast for city
   */
  getForecast(): void {
    if (!this.city || this.city.trim() === '') {
      this.errorMessage = 'Please enter a city name';
      return;
    }

    this.isLoadingForecast = true;
    this.errorMessage = '';
    this.forecast = null;

    this.apiService.getForecast(this.city, this.countryCode || undefined).subscribe({
      next: (response) => {
        if (response.error) {
          this.errorMessage = response.error;
        } else {
          this.forecast = response;
          this.successMessage = `Forecast loaded for ${response.city?.name || this.city}`;
        }
        this.isLoadingForecast = false;
      },
      error: (error) => {
        console.error('Error fetching forecast:', error);
        this.errorMessage = 'Error fetching forecast: ' + (error.error?.message || error.message || 'Unknown error');
        this.isLoadingForecast = false;
      }
    });
  }

  /**
   * Format temperature
   */
  formatTemperature(temp: number): string {
    return temp ? Math.round(temp) + '°C' : 'N/A';
  }

  /**
   * Format date
   */
  formatDate(dt: number): string {
    if (!dt) return 'N/A';
    const date = new Date(dt * 1000);
    return date.toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  /**
   * Get weather icon URL
   */
  getWeatherIconUrl(icon: string): string {
    if (!icon) return '';
    return `https://openweathermap.org/img/wn/${icon}@2x.png`;
  }

  /**
   * Clear messages after 5 seconds
   */
  clearMessages(): void {
    setTimeout(() => {
      this.successMessage = '';
      this.errorMessage = '';
    }, 5000);
  }

  /**
   * Reposition map to user's current location
   */
  repositionToUserLocation(): void {
    if (!this.traceViewerModalComponent) {
      console.error('TraceViewerModalComponent is not available');
      return;
    }

    this.getUserLocation().then((location) => {
      this.lat = location.lat;
      this.lon = location.lng;
      
      // Get city and country code from coordinates
      this.getCityFromCoordinates(location.lat, location.lng);
      
      // Automatically fetch weather for the new coordinates
      this.getCurrentWeatherByCoordinates();
      
      // Force change detection to ensure ViewChild is available
      this.cdr.detectChanges();
      
      // Open trace viewer at user's location
      const label = this.translateService.instant('API.USER_LOCATION');
      // Use setTimeout to ensure modal service is ready
      setTimeout(() => {
        if (this.traceViewerModalComponent) {
          this.traceViewerModalComponent.openAtLocation(location.lat, location.lng, label, undefined, false);
        }
      }, 0);
    }).catch(() => {
      this.errorMessage = this.translateService.instant('API.ERROR_GETTING_LOCATION');
      this.clearMessages();
    });
  }

  /**
   * Load user's location and set as default coordinates
   */
  private loadUserLocation(): void {
    this.getUserLocation().then((location) => {
      this.lat = location.lat;
      this.lon = location.lng;
      // Get city and country code from coordinates
      this.getCityFromCoordinates(location.lat, location.lng);
    }).catch(() => {
      // Keep default values if location cannot be obtained
      console.log('Using default coordinates (Paris)');
    });
  }

  /**
   * Get city and country code from coordinates using reverse geocoding
   */
  private getCityFromCoordinates(lat: number, lon: number): void {
    this.apiService.getCurrentWeatherByCoordinates(lat, lon).subscribe({
      next: (response) => {
        if (response && !response.error && response.name) {
          // Use setTimeout to avoid ExpressionChangedAfterItHasBeenCheckedError
          setTimeout(() => {
            this.city = response.name;
            if (response.sys && response.sys.country) {
              this.countryCode = response.sys.country;
            }
            this.cdr.detectChanges();
          }, 0);
        }
      },
      error: (error) => {
        // Silently fail - coordinates are set, city/country are optional
        console.log('Could not get city from coordinates:', error);
      }
    });
  }

  /**
   * Get user's current location using GPS or IP geolocation
   */
  private getUserLocation(): Promise<{ lat: number; lng: number }> {
    return new Promise((resolve, reject) => {
      // Try GPS first (more accurate)
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            resolve({
              lat: position.coords.latitude,
              lng: position.coords.longitude
            });
          },
          (error) => {
            // GPS failed, try IP-based geolocation
            console.warn('GPS geolocation failed, trying IP-based:', error);
            this.getLocationFromIP().then(resolve).catch(() => {
              // Both failed, use default (Paris)
              resolve({ lat: 48.8566, lng: 2.3522 });
            });
          },
          {
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 60000 // Accept cached position up to 1 minute old
          }
        );
      } else {
        // Geolocation not supported, try IP-based
        this.getLocationFromIP().then(resolve).catch(() => {
          resolve({ lat: 48.8566, lng: 2.3522 });
        });
      }
    });
  }

  /**
   * Get location from IP using a free geolocation API
   */
  private getLocationFromIP(): Promise<{ lat: number; lng: number }> {
    return new Promise((resolve, reject) => {
      // Use ip-api.com free service (no API key required)
      fetch('http://ip-api.com/json/?fields=status,lat,lon')
        .then(response => response.json())
        .then(data => {
          if (data.status === 'success' && data.lat && data.lon) {
            resolve({ lat: data.lat, lng: data.lon });
          } else {
            reject(new Error('IP geolocation failed'));
          }
        })
        .catch(() => reject(new Error('IP geolocation request failed')));
    });
  }

  /**
   * Handle location selected from trace viewer
   */
  onLocationSelected(location: { lat: number; lng: number }): void {
    console.log('onLocationSelected called with:', location);
    this.lat = location.lat;
    this.lon = location.lng;
    
    // Immediately fetch weather and show alert
    this.fetchAndShowWeatherAlert(location.lat, location.lng);
    
    // Clear any pending weather fetch to debounce multiple rapid calls (e.g., from dragging marker)
    if (this.weatherFetchTimeout) {
      clearTimeout(this.weatherFetchTimeout);
    }
    
    // Automatically fetch weather for the selected coordinates with debounce
    // Use setTimeout to defer to next cycle and debounce rapid updates
    this.weatherFetchTimeout = window.setTimeout(() => {
      this.getCurrentWeatherByCoordinates();
      this.weatherFetchTimeout = undefined;
    }, 500); // 500ms debounce to avoid multiple calls during marker drag
  }

  /**
   * Fetch weather for coordinates and display in alert box
   */
  private fetchAndShowWeatherAlert(lat: number, lon: number): void {
    this.apiService.getCurrentWeatherByCoordinates(lat, lon).subscribe({
      next: (response) => {
        if (response.error) {
          window.alert(`Error: ${response.error}`);
        } else {
          const city = response.name || 'Unknown';
          const country = response.sys?.country || '';
          const temp = response.main?.temp ? Math.round(response.main.temp) + '°C' : 'N/A';
          const feelsLike = response.main?.feels_like ? Math.round(response.main.feels_like) + '°C' : 'N/A';
          const description = response.weather?.[0]?.description || 'N/A';
          const humidity = response.main?.humidity || 'N/A';
          const pressure = response.main?.pressure || 'N/A';
          const windSpeed = response.wind?.speed || 'N/A';
          
          const alertMessage = `Weather at ${city}${country ? ', ' + country : ''}\n\n` +
            `Coordinates: ${lat.toFixed(4)}, ${lon.toFixed(4)}\n` +
            `Temperature: ${temp}\n` +
            `Feels like: ${feelsLike}\n` +
            `Description: ${description}\n` +
            `Humidity: ${humidity}%\n` +
            `Pressure: ${pressure} hPa\n` +
            `Wind Speed: ${windSpeed} m/s`;
          
          window.alert(alertMessage);
        }
      },
      error: (error) => {
        window.alert('Error fetching weather: ' + (error.error?.message || error.message || 'Unknown error'));
      }
    });
  }

  /**
   * Open trace viewer in selection mode to pick coordinates
   */
  openTraceViewerForSelection(): void {
    if (!this.traceViewerModalComponent) {
      console.error('TraceViewerModalComponent is not available');
      return;
    }

    // Use current coordinates from the component (lat/lon fields)
    const initialLat = this.lat || 48.8566;
    const initialLon = this.lon || 2.3522;
    const label = this.translateService.instant('API.SELECT_LOCATION');
    // Pass simpleShare: true to use simple format "Position : coordonnées" when sharing
    this.traceViewerModalComponent.openAtLocation(initialLat, initialLon, label, undefined, true, true);
  }

  /**
   * Share the current position (latitude and longitude)
   */
  sharePosition(): void {
    // Use toFixed(6) to ensure sufficient precision for GPS coordinates (6 decimals = ~0.11m accuracy)
    const latStr = this.lat.toFixed(6);
    const lonStr = this.lon.toFixed(6);
    const positionText = `${latStr}, ${lonStr}`;
    const googleMapsUrl = `https://www.google.com/maps?q=${latStr},${lonStr}`;
    const shareText = `${this.translateService.instant('API.POSITION')}: ${positionText}\n${this.translateService.instant('API.VIEW_ON_MAPS')}: ${googleMapsUrl}`;

    // Try Web Share API first (if available on mobile devices)
    if (navigator.share) {
      navigator.share({
        title: this.translateService.instant('API.SHARE_POSITION'),
        text: shareText,
        url: googleMapsUrl
      }).catch((error) => {
        // If share fails, fallback to clipboard
        console.log('Web Share API failed, using clipboard:', error);
        this.copyToClipboard(positionText, googleMapsUrl);
      });
    } else {
      // Fallback to clipboard copy
      this.copyToClipboard(positionText, googleMapsUrl);
    }
  }

  /**
   * Copy position to clipboard
   */
  private copyToClipboard(positionText: string, googleMapsUrl: string): void {
    // Try to copy both the coordinates and the Google Maps URL
    const textToCopy = `${positionText}\n${googleMapsUrl}`;
    
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textToCopy).then(() => {
        this.successMessage = this.translateService.instant('API.POSITION_COPIED');
        this.clearMessages();
      }).catch((error) => {
        console.error('Failed to copy to clipboard:', error);
        // Fallback: show in alert
        this.showPositionShareDialog(positionText, googleMapsUrl);
      });
    } else {
      // Fallback for older browsers
      this.showPositionShareDialog(positionText, googleMapsUrl);
    }
  }

  /**
   * Show position share dialog (fallback method)
   */
  private showPositionShareDialog(positionText: string, googleMapsUrl: string): void {
    const message = `${this.translateService.instant('API.POSITION')}: ${positionText}\n\n${this.translateService.instant('API.VIEW_ON_MAPS')}: ${googleMapsUrl}\n\n${this.translateService.instant('API.COPY_MANUALLY')}`;
    window.prompt(this.translateService.instant('API.SHARE_POSITION'), message);
  }
}
