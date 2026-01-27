import { Component, OnInit, OnDestroy, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService, LangChangeEvent } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import { ApiService } from '../services/api.service';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { Chart, registerables } from 'chart.js';
import { Subscription } from 'rxjs';

// Register Chart.js components
Chart.register(...registerables);

@Component({
  selector: 'app-openweathermap',
  templateUrl: './openweathermap.component.html',
  styleUrls: ['./openweathermap.component.css'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NavigationButtonsModule, TraceViewerModalComponent, BaseChartDirective]
})
export class OpenWeatherMapComponent implements OnInit, OnDestroy {

  @ViewChild(TraceViewerModalComponent) traceViewerModalComponent?: TraceViewerModalComponent;
  @ViewChild(BaseChartDirective) chart?: BaseChartDirective;

  // OpenWeatherMap data
  city: string = 'Paris';
  countryCode: string = 'FR';
  lat: number = 48.8566;
  lon: number = 2.3522;
  private lastLat: number = 48.8566;
  private lastLon: number = 2.3522;
  
  currentWeather: any = null;
  forecast: any = null;
  apiStatus: any = null;
  nominatimStatus: any = null;
  
  isLoadingCurrentWeather: boolean = false;
  isLoadingForecast: boolean = false;
  isLoadingStatus: boolean = false;
  isLoadingUserPosition: boolean = false;
  
  errorMessage: string = '';
  successMessage: string = '';
  private weatherFetchTimeout?: number;
  forecastTitle: string = '';
  currentWeatherTitle: string = '';
  private langChangeSubscription?: Subscription;
  fullAddress: string = '';

  // Chart data for temperature forecast
  public temperatureChartData: ChartConfiguration<'line'>['data'] = {
    labels: [],
    datasets: [
      {
        data: [],
        label: 'Temperature (°C)',
        borderColor: 'rgb(75, 192, 192)',
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        tension: 0.4,
        fill: true
      }
    ]
  };

  public temperatureChartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: 'top'
      },
      title: {
        display: true,
        text: ''
      }
    },
    scales: {
      y: {
        beginAtZero: false,
        title: {
          display: true,
          text: 'Temperature (°C)'
        }
      },
      x: {
        title: {
          display: true,
          text: 'Date/Time'
        }
      }
    }
  };

  constructor(
    private apiService: ApiService,
    private translateService: TranslateService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadApiStatus();
    // Don't initialize title here, let loadUserLocation() do it after getting the actual location
    this.loadUserLocation();
    
    // Subscribe to language changes to update titles
    this.langChangeSubscription = this.translateService.onLangChange.subscribe((event: LangChangeEvent) => {
      this.updateCurrentWeatherTitle();
      this.updateForecastTitle();
    });
  }

  ngOnDestroy(): void {
    if (this.langChangeSubscription) {
      this.langChangeSubscription.unsubscribe();
    }
  }

  /**
   * Update current weather title with current city and country
   */
  private updateCurrentWeatherTitle(): void {
    this.currentWeatherTitle = `${this.translateService.instant('API.CURRENT_WEATHER')} - ${this.city}, ${this.countryCode}`;
  }

  /**
   * Update forecast title if forecast data exists
   */
  private updateForecastTitle(): void {
    if (this.forecast && this.forecast.list && this.forecast.list.length > 0) {
      // Recalculate forecast title with new language
      this.updateTemperatureChart();
    }
  }

  /**
   * Load API status
   */
  loadApiStatus(): void {
    this.isLoadingStatus = true;
    this.errorMessage = '';
    
    // Check OpenWeatherMap API status
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
    
    // Check Nominatim (OpenStreetMap) API status
    this.checkNominatimStatus();
  }

  /**
   * Check Nominatim (OpenStreetMap) API status
   */
  private checkNominatimStatus(): void {
    // Test Nominatim API with a simple reverse geocoding request
    const testUrl = 'https://nominatim.openstreetmap.org/reverse?format=json&lat=48.8566&lon=2.3522&zoom=18&addressdetails=1';
    
    fetch(testUrl, {
      headers: {
        'User-Agent': 'PATTOOL Weather App',
        'Accept': 'application/json'
      }
    })
    .then(response => {
      if (response.ok) {
        this.nominatimStatus = {
          service: 'Nominatim (OpenStreetMap)',
          status: 'available'
        };
      } else {
        this.nominatimStatus = {
          service: 'Nominatim (OpenStreetMap)',
          status: 'unavailable'
        };
      }
      this.cdr.detectChanges();
    })
    .catch(error => {
      console.error('Error checking Nominatim status:', error);
      this.nominatimStatus = {
        service: 'Nominatim (OpenStreetMap)',
        status: 'unavailable'
      };
      this.cdr.detectChanges();
    });
  }

  /**
   * Get current weather by coordinates
   */
  getCurrentWeatherByCoordinates(): void {
    // Ensure we use the coordinates from the input fields
    const lat = this.lat;
    const lon = this.lon;
    
    // Validate coordinates
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
      this.errorMessage = 'Invalid coordinates. Please set valid latitude and longitude.';
      return;
    }
    
    console.log('Fetching weather for coordinates:', lat, lon);
    
    this.isLoadingCurrentWeather = true;
    this.errorMessage = '';
    this.currentWeather = null;

    this.apiService.getCurrentWeatherByCoordinates(lat, lon).subscribe({
      next: (response) => {
        if (response.error) {
          this.errorMessage = response.error;
        } else {
          this.currentWeather = response;
          // DO NOT update this.city with response.name - keep the city from Nominatim (address)
          // Use this.city (from Nominatim) instead of response.name (from OpenWeatherMap) for consistency
          // Update current weather title with city from Nominatim (this.city) and country from response
          const countryCode = response.sys?.country || this.countryCode;
          const location = countryCode ? `${this.city}, ${countryCode}` : this.city;
          this.currentWeatherTitle = `${this.translateService.instant('API.CURRENT_WEATHER')} - ${location}`;
          // Update country code if available from response, but keep city from Nominatim
          if (response.sys?.country) {
            this.countryCode = response.sys.country;
          }
          // DO NOT display success message - weather data is already visible in the UI
        }
        this.isLoadingCurrentWeather = false;
        this.cdr.markForCheck();
      },
      error: (error) => {
        console.error('Error fetching current weather by coordinates:', error);
        this.errorMessage = 'Error fetching weather: ' + (error.error?.message || error.message || 'Unknown error');
        this.isLoadingCurrentWeather = false;
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * Get forecast using coordinates
   */
  getForecast(): void {
    // Ensure we use the coordinates from the input fields
    const lat = this.lat;
    const lon = this.lon;
    
    // Validate coordinates
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
      this.errorMessage = 'Coordinates are required for forecast. Please set latitude and longitude.';
      return;
    }
    
    console.log('Fetching forecast for coordinates:', lat, lon);

    this.isLoadingForecast = true;
    this.errorMessage = '';
    this.forecast = null;
    this.cdr.markForCheck();

    this.apiService.getForecastByCoordinates(lat, lon).subscribe({
      next: (response) => {
        if (response.error) {
          this.errorMessage = response.error;
        } else {
          this.forecast = response;
          // Update chart with forecast data
          this.updateTemperatureChart();
        }
        this.isLoadingForecast = false;
        this.cdr.markForCheck();
      },
      error: (error) => {
        console.error('Error fetching forecast:', error);
        this.errorMessage = 'Error fetching forecast: ' + (error.error?.message || error.message || 'Unknown error');
        this.isLoadingForecast = false;
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * Update temperature chart with forecast data
   */
  private updateTemperatureChart(): void {
    if (!this.forecast || !this.forecast.list || this.forecast.list.length === 0) {
      return;
    }

    const labels: string[] = [];
    const temperatures: number[] = [];
    let firstDate: Date | null = null;
    let lastDate: Date | null = null;

    // Get current language for date formatting
    const currentLang = this.translateService.currentLang || 'fr-FR';

    this.forecast.list.forEach((item: any) => {
      if (item.dt && item.main?.temp !== undefined) {
        const date = new Date(item.dt * 1000);
        
        // Track first and last dates
        if (firstDate === null || date < firstDate) {
          firstDate = date;
        }
        if (lastDate === null || date > lastDate) {
          lastDate = date;
        }
        
        // Format date based on user's language
        const dateStr = date.toLocaleString(currentLang, {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
        labels.push(dateStr);
        temperatures.push(Math.round(item.main.temp));
      }
    });

    // Update chart title with actual date range
    if (firstDate !== null && lastDate !== null) {
      const startDate: Date = firstDate;
      const endDate: Date = lastDate;
      const startStr = startDate.toLocaleDateString(currentLang, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
      const endStr = endDate.toLocaleDateString(currentLang, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
      
      // Use the city from current weather (this.city) instead of forecast city
      // to ensure consistency, as API may return different city names for same coordinates
      const cityName = this.city || this.forecast.city?.name || 'Unknown';
      const countryCode = this.countryCode || this.forecast.city?.country || '';
      const location = countryCode ? `${cityName}, ${countryCode}` : cityName;
      
      // Update forecast section title with location
      this.forecastTitle = startStr === endStr 
        ? `${this.translateService.instant('API.FORECAST')} - ${location} - ${startStr}`
        : `${this.translateService.instant('API.FORECAST')} - ${location} ${startStr} ${this.translateService.instant('TO')} ${endStr}`;
      
      // Update chart title
      const chartTitleText = startStr === endStr 
        ? `${this.translateService.instant('API.TEMPERATURE')} - ${startStr}`
        : `${this.translateService.instant('API.TEMPERATURE')} ${startStr} ${this.translateService.instant('TO')} ${endStr}`;
      
      // Update title in options
      if (this.temperatureChartOptions.plugins && this.temperatureChartOptions.plugins.title) {
        this.temperatureChartOptions.plugins.title.text = chartTitleText;
      }
    }

    this.temperatureChartData = {
      labels: labels,
      datasets: [
        {
          data: temperatures,
          label: this.translateService.instant('API.TEMPERATURE'),
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
          tension: 0.4,
          fill: true
        }
      ]
    };

    // Update chart if it exists
    this.cdr.detectChanges();
    if (this.chart) {
      setTimeout(() => {
        this.chart?.update('none'); // 'none' prevents animation
      }, 100);
    }
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
   * Load user's location and set as default coordinates
   */
  private loadUserLocation(): void {
    this.getUserLocation().then((location) => {
      this.lat = location.lat;
      this.lon = location.lng;
      this.lastLat = location.lat;
      this.lastLon = location.lng;
      // Get city and country code from coordinates (title will be updated in the callback)
      this.getCityFromCoordinates(location.lat, location.lng);
    }).catch(() => {
      // Keep default values if location cannot be obtained
      console.log('Using default coordinates (Paris)');
      this.lastLat = this.lat;
      this.lastLon = this.lon;
      // Initialize title with default location
      this.updateCurrentWeatherTitle();
    });
  }

  /**
   * Get user's position and update coordinates
   */
  getUserPosition(): void {
    this.isLoadingUserPosition = true;
    this.errorMessage = '';
    this.successMessage = '';
    
    this.getUserLocation().then((location) => {
      this.lat = location.lat;
      this.lon = location.lng;
      // Reset weather data when getting new position
      this.currentWeather = null;
      this.forecast = null;
      this.forecastTitle = '';
      // Title will be updated by getFullAddressFromCoordinates with city and country
      // Get full address, city and country from coordinates (using Nominatim, no OpenWeatherMap API call)
      // This will also update city, countryCode, fullAddress and currentWeatherTitle
      this.getFullAddressFromCoordinates(location.lat, location.lng).finally(() => {
        this.isLoadingUserPosition = false;
        this.cdr.detectChanges();
      });
    }).catch(() => {
      this.errorMessage = this.translateService.instant('API.ERROR_GETTING_LOCATION');
      this.successMessage = '';
      this.isLoadingUserPosition = false;
      this.clearMessages();
      this.cdr.detectChanges();
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
            // Update current weather title with the retrieved city
            this.updateCurrentWeatherTitle();
            // Get full address from coordinates
            this.getFullAddressFromCoordinates(lat, lon);
            this.cdr.detectChanges();
          }, 0);
        }
      },
      error: (error) => {
        // Silently fail - coordinates are set, city/country are optional
        console.log('Could not get city from coordinates:', error);
        // Update title with coordinates if city retrieval fails
        this.updateCurrentWeatherTitle();
        // Still try to get full address
        this.getFullAddressFromCoordinates(lat, lon);
      }
    });
  }

  /**
   * Get full address from coordinates using reverse geocoding (Nominatim)
   */
  private getFullAddressFromCoordinates(lat: number, lon: number): Promise<void> {
    // Use Nominatim (OpenStreetMap) for reverse geocoding - free and no API key required
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    
    return fetch(url, {
      headers: {
        'User-Agent': 'PATTOOL Weather App', // Required by Nominatim
        'Accept': 'application/json'
      }
    })
    .then(response => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      if (data && data.address) {
        const address = data.address;
        const addressParts: string[] = [];
        
        // Build address from most specific to least specific
        if (address.house_number && address.road) {
          addressParts.push(`${address.road} ${address.house_number}`);
        } else if (address.road) {
          addressParts.push(address.road);
        }
        
        if (address.postcode) {
          addressParts.push(address.postcode);
        }
        
        // Extract city (try city, town, village, municipality, or county)
        const cityName = address.city || address.town || address.village || address.municipality || address.county || '';
        if (cityName) {
          addressParts.push(cityName);
          // Update city in component (for select box)
          this.city = cityName;
        }
        
        if (address.state || address.region) {
          addressParts.push(address.state || address.region);
        }
        
        // Extract country code (ISO 3166-1 alpha-2)
        if (address.country_code) {
          // Nominatim returns lowercase country codes, convert to uppercase
          this.countryCode = address.country_code.toUpperCase();
        }
        
        if (address.country) {
          addressParts.push(address.country);
        }
        
        this.fullAddress = addressParts.length > 0 ? addressParts.join(', ') : data.display_name || '';
      } else if (data && data.display_name) {
        this.fullAddress = data.display_name;
        // Try to extract city from display_name if address is not available
        const parts = data.display_name.split(',');
        if (parts.length > 0) {
          this.city = parts[0].trim();
        }
      } else {
        this.fullAddress = '';
      }
      
      // Update current weather title with city and country
      this.updateCurrentWeatherTitle();
      this.cdr.detectChanges();
    })
    .catch(error => {
      console.log('Could not get full address from coordinates:', error);
      this.fullAddress = '';
      this.cdr.detectChanges();
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
    // Reset all weather data when returning from map
    this.forecastTitle = '';
    this.forecast = null;
    this.currentWeather = null;
    // Title will be updated by getFullAddressFromCoordinates with city and country
    this.errorMessage = '';
    this.successMessage = '';
    this.isLoadingCurrentWeather = false;
    this.isLoadingForecast = false;
    this.cdr.markForCheck();
    
    // Check if coordinates have changed
    const coordinatesChanged = Math.abs(this.lastLat - location.lat) > 0.0001 || 
                                Math.abs(this.lastLon - location.lng) > 0.0001;
    
    this.lat = location.lat;
    this.lon = location.lng;
    
    // Force change detection to update the input fields
    this.cdr.detectChanges();
    
    // Get full address, city and country from coordinates (using Nominatim, no OpenWeatherMap API call)
    // This will also update city, countryCode, fullAddress and currentWeatherTitle
    this.getFullAddressFromCoordinates(location.lat, location.lng);
    
    // DO NOT fetch weather automatically - only update coordinates, address, city and country
    // Weather will be fetched only when user clicks "Météo GPS" or "Obtenir les prévisions"
    
    // Update last known coordinates
    if (coordinatesChanged) {
      this.lastLat = location.lat;
      this.lastLon = location.lng;
    }
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
   * Open trace viewer with current coordinates displayed in Latitude and Longitude fields
   */
  openTraceViewerForSelection(): void {
    if (!this.traceViewerModalComponent) {
      console.error('TraceViewerModalComponent is not available');
      return;
    }

    // Use current coordinates from the component (lat/lon fields)
    const initialLat = this.lat || 48.8566;
    const initialLon = this.lon || 2.3522;
    const label = `${initialLat.toFixed(6)}, ${initialLon.toFixed(6)}`;
    // Open at location with coordinates, enable selection mode so clicks update coordinates, simple share mode
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
