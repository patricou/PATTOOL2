import { Component, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import { ApiService } from '../services/api.service';

@Component({
  selector: 'app-api',
  templateUrl: './api.component.html',
  styleUrls: ['./api.component.css'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NavigationButtonsModule, TraceViewerModalComponent]
})
export class ApiComponent implements OnInit {

  @ViewChild(TraceViewerModalComponent) traceViewerModalComponent?: TraceViewerModalComponent;

  // OpenWeatherMap data
  city: string = 'Paris';
  countryCode: string = 'FR';
  lat: number = 48.8566;
  lon: number = 2.3522;
  alt: number | null = null; // Altitude in meters
  
  currentWeather: any = null;
  forecast: any = null;
  apiStatus: any = null;
  
  isLoadingCurrentWeather: boolean = false;
  isLoadingForecast: boolean = false;
  isLoadingStatus: boolean = false;
  
  errorMessage: string = '';
  successMessage: string = '';

  constructor(
    private apiService: ApiService,
    private translateService: TranslateService
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

    this.apiService.getCurrentWeatherByCoordinates(this.lat, this.lon, this.alt).subscribe({
      next: (response) => {
        if (response.error) {
          this.errorMessage = response.error;
        } else {
          this.currentWeather = response;
          this.city = response.name || this.city;
          this.successMessage = `Weather data loaded for coordinates (${this.lat}, ${this.lon})`;
        }
        this.isLoadingCurrentWeather = false;
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
   * Open trace viewer with current coordinates
   */
  openTraceViewer(): void {
    if (this.traceViewerModalComponent) {
      const label = `${this.city || 'Location'} (${this.lat.toFixed(5)}, ${this.lon.toFixed(5)})`;
      this.traceViewerModalComponent.openAtLocation(this.lat, this.lon, label, undefined, false);
    }
  }

  /**
   * Load user's location and set as default coordinates
   */
  private loadUserLocation(): void {
    this.getUserLocation().then((location) => {
      this.lat = location.lat;
      this.lon = location.lng;
      this.alt = location.alt || null;
      // Get city and country code from coordinates
      this.getCityFromCoordinates(location.lat, location.lng);
    }).catch(() => {
      // Keep default values if location cannot be obtained
      console.log('Using default coordinates (Paris)');
      this.alt = null;
    });
  }

  /**
   * Get city and country code from coordinates using reverse geocoding
   */
  private getCityFromCoordinates(lat: number, lon: number): void {
    this.apiService.getCurrentWeatherByCoordinates(lat, lon, this.alt).subscribe({
      next: (response) => {
        if (response && !response.error && response.name) {
          this.city = response.name;
          if (response.sys && response.sys.country) {
            this.countryCode = response.sys.country;
          }
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
  private getUserLocation(): Promise<{ lat: number; lng: number; alt?: number | null }> {
    return new Promise((resolve, reject) => {
      // Try GPS first (more accurate)
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            // Capture altitude if available from mobile device
            const altitude = position.coords.altitude !== null && !isNaN(position.coords.altitude) 
              ? position.coords.altitude 
              : null;
            resolve({
              lat: position.coords.latitude,
              lng: position.coords.longitude,
              alt: altitude
            });
          },
          (error) => {
            // GPS failed, try IP-based geolocation
            console.warn('GPS geolocation failed, trying IP-based:', error);
            this.getLocationFromIP().then(resolve).catch(() => {
              // Both failed, use default (Paris)
              resolve({ lat: 48.8566, lng: 2.3522, alt: null });
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
          resolve({ lat: 48.8566, lng: 2.3522, alt: null });
        });
      }
    });
  }

  /**
   * Get location from IP using a free geolocation API
   */
  private getLocationFromIP(): Promise<{ lat: number; lng: number; alt?: number | null }> {
    return new Promise((resolve, reject) => {
      // Use ip-api.com free service (no API key required)
      fetch('http://ip-api.com/json/?fields=status,lat,lon')
        .then(response => response.json())
        .then(data => {
          if (data.status === 'success' && data.lat && data.lon) {
            resolve({ lat: data.lat, lng: data.lon, alt: null });
          } else {
            reject(new Error('IP geolocation failed'));
          }
        })
        .catch(() => reject(new Error('IP geolocation request failed')));
    });
  }

  /**
   * Open trace viewer in selection mode to pick coordinates
   */
  openTraceViewerForSelection(): void {
    if (this.traceViewerModalComponent) {
      // Subscribe to location selection event before opening
      if (this.traceViewerModalComponent.locationSelected) {
        this.traceViewerModalComponent.locationSelected.subscribe((location: { lat: number; lng: number }) => {
          this.lat = location.lat;
          this.lon = location.lng;
        });
      }

      // Get user's current location (GPS or IP-based)
      this.getUserLocation().then((location) => {
        // Update lat/lon with user's location
        this.lat = location.lat;
        this.lon = location.lng;
        this.alt = location.alt || null;
        
        const label = this.translateService.instant('API.SELECT_LOCATION');
        this.traceViewerModalComponent!.openAtLocation(location.lat, location.lng, label, undefined, true);
      }).catch(() => {
        // Fallback to current coordinates or default
        const initialLat = this.lat || 48.8566;
        const initialLon = this.lon || 2.3522;
        const label = this.translateService.instant('API.SELECT_LOCATION');
        this.traceViewerModalComponent!.openAtLocation(initialLat, initialLon, label, undefined, true);
      });
    }
  }
}
