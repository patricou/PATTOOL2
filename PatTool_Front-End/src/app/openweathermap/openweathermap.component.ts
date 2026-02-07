import { Component, OnInit, OnDestroy, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService, LangChangeEvent } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
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
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, NavigationButtonsModule, TraceViewerModalComponent, BaseChartDirective]
})
export class OpenWeatherMapComponent implements OnInit, OnDestroy {

  @ViewChild(TraceViewerModalComponent) traceViewerModalComponent?: TraceViewerModalComponent;
  @ViewChild(BaseChartDirective) chart?: BaseChartDirective;

  // Expose Math to template
  Math = Math;
  // Expose Number.isNaN to template
  isNaN = Number.isNaN;

  // OpenWeatherMap data
  city: string = 'Paris';
  countryCode: string = 'FR';
  lat: number = 48.8566;
  lon: number = 2.3522;
  alt: number | null = null; // Altitude in meters
  altFromMobile: boolean = false; // Flag to indicate if altitude comes from mobile GPS
  allAltitudes: any[] = []; // All available altitudes with sources
  private lastLat: number = 48.8566;
  private lastLon: number = 2.3522;
  
  currentWeather: any = null;
  forecast: any = null;
  apiStatus: any = null;
  nominatimStatus: any = null;
  openElevationStatus: any = null;
  
  isLoadingCurrentWeather: boolean = false;
  isLoadingForecast: boolean = false;
  isLoadingStatus: boolean = false;
  isLoadingUserPosition: boolean = false;
  isLoadingCitySearch: boolean = false;
  citySearchResults: any[] = [];
  showCitySearchResults: boolean = false;
  
  // Forecast display mode: 'hourly' (3-hour intervals) or 'daily' (daily summary)
  forecastDisplayMode: 'hourly' | 'daily' = 'hourly';
  displayForecastList: any[] = [];
  
  // Country codes list (ISO 3166-1 alpha-2)
  countryCodes: { code: string; name: string }[] = [
    { code: '', name: 'Tous les pays' },
    { code: 'FR', name: 'France' },
    { code: 'CH', name: 'Suisse' },
    { code: 'AD', name: 'Andorre' },
    { code: 'AE', name: 'Émirats arabes unis' },
    { code: 'AF', name: 'Afghanistan' },
    { code: 'AG', name: 'Antigua-et-Barbuda' },
    { code: 'AI', name: 'Anguilla' },
    { code: 'AL', name: 'Albanie' },
    { code: 'AM', name: 'Arménie' },
    { code: 'AO', name: 'Angola' },
    { code: 'AQ', name: 'Antarctique' },
    { code: 'AR', name: 'Argentine' },
    { code: 'AS', name: 'Samoa américaines' },
    { code: 'AT', name: 'Autriche' },
    { code: 'AU', name: 'Australie' },
    { code: 'AW', name: 'Aruba' },
    { code: 'AX', name: 'Îles Åland' },
    { code: 'AZ', name: 'Azerbaïdjan' },
    { code: 'BA', name: 'Bosnie-Herzégovine' },
    { code: 'BB', name: 'Barbade' },
    { code: 'BD', name: 'Bangladesh' },
    { code: 'BE', name: 'Belgique' },
    { code: 'BF', name: 'Burkina Faso' },
    { code: 'BG', name: 'Bulgarie' },
    { code: 'BH', name: 'Bahreïn' },
    { code: 'BI', name: 'Burundi' },
    { code: 'BJ', name: 'Bénin' },
    { code: 'BL', name: 'Saint-Barthélemy' },
    { code: 'BM', name: 'Bermudes' },
    { code: 'BN', name: 'Brunei' },
    { code: 'BO', name: 'Bolivie' },
    { code: 'BQ', name: 'Pays-Bas caribéens' },
    { code: 'BR', name: 'Brésil' },
    { code: 'BS', name: 'Bahamas' },
    { code: 'BT', name: 'Bhoutan' },
    { code: 'BV', name: 'Île Bouvet' },
    { code: 'BW', name: 'Botswana' },
    { code: 'BY', name: 'Biélorussie' },
    { code: 'BZ', name: 'Belize' },
    { code: 'CA', name: 'Canada' },
    { code: 'CC', name: 'Îles Cocos' },
    { code: 'CD', name: 'RD Congo' },
    { code: 'CF', name: 'République centrafricaine' },
    { code: 'CG', name: 'Congo' },
    { code: 'CI', name: 'Côte d\'Ivoire' },
    { code: 'CK', name: 'Îles Cook' },
    { code: 'CL', name: 'Chili' },
    { code: 'CM', name: 'Cameroun' },
    { code: 'CN', name: 'Chine' },
    { code: 'CO', name: 'Colombie' },
    { code: 'CR', name: 'Costa Rica' },
    { code: 'CU', name: 'Cuba' },
    { code: 'CV', name: 'Cap-Vert' },
    { code: 'CW', name: 'Curaçao' },
    { code: 'CX', name: 'Île Christmas' },
    { code: 'CY', name: 'Chypre' },
    { code: 'CZ', name: 'Tchéquie' },
    { code: 'DE', name: 'Allemagne' },
    { code: 'DJ', name: 'Djibouti' },
    { code: 'DK', name: 'Danemark' },
    { code: 'DM', name: 'Dominique' },
    { code: 'DO', name: 'République dominicaine' },
    { code: 'DZ', name: 'Algérie' },
    { code: 'EC', name: 'Équateur' },
    { code: 'EE', name: 'Estonie' },
    { code: 'EG', name: 'Égypte' },
    { code: 'EH', name: 'Sahara occidental' },
    { code: 'ER', name: 'Érythrée' },
    { code: 'ES', name: 'Espagne' },
    { code: 'ET', name: 'Éthiopie' },
    { code: 'FI', name: 'Finlande' },
    { code: 'FJ', name: 'Fidji' },
    { code: 'FK', name: 'Îles Malouines' },
    { code: 'FM', name: 'Micronésie' },
    { code: 'FO', name: 'Îles Féroé' },
    { code: 'GA', name: 'Gabon' },
    { code: 'GB', name: 'Royaume-Uni' },
    { code: 'GD', name: 'Grenade' },
    { code: 'GE', name: 'Géorgie' },
    { code: 'GF', name: 'Guyane française' },
    { code: 'GG', name: 'Guernesey' },
    { code: 'GH', name: 'Ghana' },
    { code: 'GI', name: 'Gibraltar' },
    { code: 'GL', name: 'Groenland' },
    { code: 'GM', name: 'Gambie' },
    { code: 'GN', name: 'Guinée' },
    { code: 'GP', name: 'Guadeloupe' },
    { code: 'GQ', name: 'Guinée équatoriale' },
    { code: 'GR', name: 'Grèce' },
    { code: 'GS', name: 'Géorgie du Sud-et-les Îles Sandwich du Sud' },
    { code: 'GT', name: 'Guatemala' },
    { code: 'GU', name: 'Guam' },
    { code: 'GW', name: 'Guinée-Bissau' },
    { code: 'GY', name: 'Guyane' },
    { code: 'HK', name: 'Hong Kong' },
    { code: 'HM', name: 'Îles Heard-et-MacDonald' },
    { code: 'HN', name: 'Honduras' },
    { code: 'HR', name: 'Croatie' },
    { code: 'HT', name: 'Haïti' },
    { code: 'HU', name: 'Hongrie' },
    { code: 'ID', name: 'Indonésie' },
    { code: 'IE', name: 'Irlande' },
    { code: 'IL', name: 'Israël' },
    { code: 'IM', name: 'Île de Man' },
    { code: 'IN', name: 'Inde' },
    { code: 'IO', name: 'Territoire britannique de l\'océan Indien' },
    { code: 'IQ', name: 'Irak' },
    { code: 'IR', name: 'Iran' },
    { code: 'IS', name: 'Islande' },
    { code: 'IT', name: 'Italie' },
    { code: 'JE', name: 'Jersey' },
    { code: 'JM', name: 'Jamaïque' },
    { code: 'JO', name: 'Jordanie' },
    { code: 'JP', name: 'Japon' },
    { code: 'KE', name: 'Kenya' },
    { code: 'KG', name: 'Kirghizistan' },
    { code: 'KH', name: 'Cambodge' },
    { code: 'KI', name: 'Kiribati' },
    { code: 'KM', name: 'Comores' },
    { code: 'KN', name: 'Saint-Kitts-et-Nevis' },
    { code: 'KP', name: 'Corée du Nord' },
    { code: 'KR', name: 'Corée du Sud' },
    { code: 'KW', name: 'Koweït' },
    { code: 'KY', name: 'Îles Caïmans' },
    { code: 'KZ', name: 'Kazakhstan' },
    { code: 'LA', name: 'Laos' },
    { code: 'LB', name: 'Liban' },
    { code: 'LC', name: 'Sainte-Lucie' },
    { code: 'LI', name: 'Liechtenstein' },
    { code: 'LK', name: 'Sri Lanka' },
    { code: 'LR', name: 'Liberia' },
    { code: 'LS', name: 'Lesotho' },
    { code: 'LT', name: 'Lituanie' },
    { code: 'LU', name: 'Luxembourg' },
    { code: 'LV', name: 'Lettonie' },
    { code: 'LY', name: 'Libye' },
    { code: 'MA', name: 'Maroc' },
    { code: 'MC', name: 'Monaco' },
    { code: 'MD', name: 'Moldavie' },
    { code: 'ME', name: 'Monténégro' },
    { code: 'MF', name: 'Saint-Martin' },
    { code: 'MG', name: 'Madagascar' },
    { code: 'MH', name: 'Îles Marshall' },
    { code: 'MK', name: 'Macédoine du Nord' },
    { code: 'ML', name: 'Mali' },
    { code: 'MM', name: 'Myanmar' },
    { code: 'MN', name: 'Mongolie' },
    { code: 'MO', name: 'Macao' },
    { code: 'MP', name: 'Îles Mariannes du Nord' },
    { code: 'MQ', name: 'Martinique' },
    { code: 'MR', name: 'Mauritanie' },
    { code: 'MS', name: 'Montserrat' },
    { code: 'MT', name: 'Malte' },
    { code: 'MU', name: 'Maurice' },
    { code: 'MV', name: 'Maldives' },
    { code: 'MW', name: 'Malawi' },
    { code: 'MX', name: 'Mexique' },
    { code: 'MY', name: 'Malaisie' },
    { code: 'MZ', name: 'Mozambique' },
    { code: 'NA', name: 'Namibie' },
    { code: 'NC', name: 'Nouvelle-Calédonie' },
    { code: 'NE', name: 'Niger' },
    { code: 'NF', name: 'Île Norfolk' },
    { code: 'NG', name: 'Nigeria' },
    { code: 'NI', name: 'Nicaragua' },
    { code: 'NL', name: 'Pays-Bas' },
    { code: 'NO', name: 'Norvège' },
    { code: 'NP', name: 'Népal' },
    { code: 'NR', name: 'Nauru' },
    { code: 'NU', name: 'Niué' },
    { code: 'NZ', name: 'Nouvelle-Zélande' },
    { code: 'OM', name: 'Oman' },
    { code: 'PA', name: 'Panama' },
    { code: 'PE', name: 'Pérou' },
    { code: 'PF', name: 'Polynésie française' },
    { code: 'PG', name: 'Papouasie-Nouvelle-Guinée' },
    { code: 'PH', name: 'Philippines' },
    { code: 'PK', name: 'Pakistan' },
    { code: 'PL', name: 'Pologne' },
    { code: 'PM', name: 'Saint-Pierre-et-Miquelon' },
    { code: 'PN', name: 'Pitcairn' },
    { code: 'PR', name: 'Porto Rico' },
    { code: 'PS', name: 'Palestine' },
    { code: 'PT', name: 'Portugal' },
    { code: 'PW', name: 'Palaos' },
    { code: 'PY', name: 'Paraguay' },
    { code: 'QA', name: 'Qatar' },
    { code: 'RE', name: 'La Réunion' },
    { code: 'RO', name: 'Roumanie' },
    { code: 'RS', name: 'Serbie' },
    { code: 'RU', name: 'Russie' },
    { code: 'RW', name: 'Rwanda' },
    { code: 'SA', name: 'Arabie saoudite' },
    { code: 'SB', name: 'Îles Salomon' },
    { code: 'SC', name: 'Seychelles' },
    { code: 'SD', name: 'Soudan' },
    { code: 'SE', name: 'Suède' },
    { code: 'SG', name: 'Singapour' },
    { code: 'SH', name: 'Sainte-Hélène' },
    { code: 'SI', name: 'Slovénie' },
    { code: 'SJ', name: 'Svalbard et Jan Mayen' },
    { code: 'SK', name: 'Slovaquie' },
    { code: 'SL', name: 'Sierra Leone' },
    { code: 'SM', name: 'Saint-Marin' },
    { code: 'SN', name: 'Sénégal' },
    { code: 'SO', name: 'Somalie' },
    { code: 'SR', name: 'Suriname' },
    { code: 'SS', name: 'Soudan du Sud' },
    { code: 'ST', name: 'São Tomé-et-Príncipe' },
    { code: 'SV', name: 'Salvador' },
    { code: 'SX', name: 'Saint-Martin' },
    { code: 'SY', name: 'Syrie' },
    { code: 'SZ', name: 'Eswatini' },
    { code: 'TC', name: 'Îles Turques-et-Caïques' },
    { code: 'TD', name: 'Tchad' },
    { code: 'TF', name: 'Terres australes françaises' },
    { code: 'TG', name: 'Togo' },
    { code: 'TH', name: 'Thaïlande' },
    { code: 'TJ', name: 'Tadjikistan' },
    { code: 'TK', name: 'Tokelau' },
    { code: 'TL', name: 'Timor oriental' },
    { code: 'TM', name: 'Turkménistan' },
    { code: 'TN', name: 'Tunisie' },
    { code: 'TO', name: 'Tonga' },
    { code: 'TR', name: 'Turquie' },
    { code: 'TT', name: 'Trinité-et-Tobago' },
    { code: 'TV', name: 'Tuvalu' },
    { code: 'TW', name: 'Taïwan' },
    { code: 'TZ', name: 'Tanzanie' },
    { code: 'UA', name: 'Ukraine' },
    { code: 'UG', name: 'Ouganda' },
    { code: 'UM', name: 'Îles mineures éloignées des États-Unis' },
    { code: 'US', name: 'États-Unis' },
    { code: 'UY', name: 'Uruguay' },
    { code: 'UZ', name: 'Ouzbékistan' },
    { code: 'VA', name: 'Vatican' },
    { code: 'VC', name: 'Saint-Vincent-et-les-Grenadines' },
    { code: 'VE', name: 'Venezuela' },
    { code: 'VG', name: 'Îles Vierges britanniques' },
    { code: 'VI', name: 'Îles Vierges américaines' },
    { code: 'VN', name: 'Viêt Nam' },
    { code: 'VU', name: 'Vanuatu' },
    { code: 'WF', name: 'Wallis-et-Futuna' },
    { code: 'WS', name: 'Samoa' },
    { code: 'YE', name: 'Yémen' },
    { code: 'YT', name: 'Mayotte' },
    { code: 'ZA', name: 'Afrique du Sud' },
    { code: 'ZM', name: 'Zambie' },
    { code: 'ZW', name: 'Zimbabwe' }
  ];
  
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
    
    // Check OpenElevation API status
    this.checkOpenElevationStatus();
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
   * Check OpenElevation API status
   */
  private checkOpenElevationStatus(): void {
    // Test OpenElevation API with a simple elevation lookup request
    const testUrl = 'https://api.open-elevation.com/api/v1/lookup?locations=48.8566,2.3522';
    
    fetch(testUrl, {
      headers: {
        'Accept': 'application/json'
      }
    })
    .then(response => {
      if (response.ok) {
        return response.json();
      } else {
        throw new Error('OpenElevation API returned error');
      }
    })
    .then(data => {
      // Check if response has the expected structure
      if (data && data.results && data.results.length > 0 && data.results[0].elevation !== undefined) {
        this.openElevationStatus = {
          service: 'OpenElevation API',
          status: 'available'
        };
      } else {
        this.openElevationStatus = {
          service: 'OpenElevation API',
          status: 'unavailable'
        };
      }
      this.cdr.detectChanges();
    })
    .catch(error => {
      console.error('Error checking OpenElevation status:', error);
      this.openElevationStatus = {
        service: 'OpenElevation API',
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
    // Only send altitude if it's really from mobile GPS
    const alt = this.altFromMobile ? this.alt : null;
    
    // Validate coordinates
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
      this.errorMessage = 'Invalid coordinates. Please set valid latitude and longitude.';
      return;
    }
    
    this.isLoadingCurrentWeather = true;
    this.errorMessage = '';
    this.currentWeather = null;

    this.apiService.getCurrentWeatherByCoordinates(lat, lon, alt).subscribe({
      next: (response) => {
        if (response.error) {
          this.errorMessage = response.error;
        } else {
          this.currentWeather = response;
          // Get all altitudes from response
          if (response.altitudes && Array.isArray(response.altitudes)) {
            this.allAltitudes = response.altitudes;
          }
          // If altitude is in response, update local alt value for consistency
          if (response.altitude !== null && response.altitude !== undefined) {
            this.alt = typeof response.altitude === 'number' ? response.altitude : parseFloat(String(response.altitude));
          } else if (this.allAltitudes.length > 0) {
            // Use first altitude from allAltitudes if no primary altitude in response
            this.alt = this.allAltitudes[0].altitude;
          }
          // Force change detection to update altitude display
          this.cdr.detectChanges();
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
    // Only send altitude if it's really from mobile GPS
    const alt = this.altFromMobile ? this.alt : null;
    
    // Validate coordinates
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
      this.errorMessage = 'Coordinates are required for forecast. Please set latitude and longitude.';
      return;
    }
    
    this.isLoadingForecast = true;
    this.errorMessage = '';
    this.forecast = null;
    this.cdr.markForCheck();

    this.apiService.getForecastByCoordinates(lat, lon, alt).subscribe({
      next: (response) => {
        if (response.error) {
          this.errorMessage = response.error;
        } else {
          this.forecast = response;
          // Process forecast data based on display mode
          this.processForecastData();
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
   * Process forecast data based on display mode (hourly or daily)
   */
  private processForecastData(): void {
    if (!this.forecast || !this.forecast.list || this.forecast.list.length === 0) {
      this.displayForecastList = [];
      return;
    }

    if (this.forecastDisplayMode === 'hourly') {
      // Show all 3-hour intervals
      this.displayForecastList = this.forecast.list;
    } else {
      // Group by day and calculate daily averages/summaries
      this.displayForecastList = this.groupForecastByDay(this.forecast.list);
    }
  }

  /**
   * Group forecast data by day (calculate daily averages)
   */
  private groupForecastByDay(forecastList: any[]): any[] {
    const dailyGroups: { [key: string]: any[] } = {};

    // Group forecasts by day
    forecastList.forEach((item: any) => {
      if (item.dt) {
        const date = new Date(item.dt * 1000);
        const dayKey = date.toISOString().split('T')[0]; // YYYY-MM-DD
        
        if (!dailyGroups[dayKey]) {
          dailyGroups[dayKey] = [];
        }
        dailyGroups[dayKey].push(item);
      }
    });

    // Calculate daily averages and create summary objects
    const dailyForecasts: any[] = [];
    Object.keys(dailyGroups).sort().forEach(dayKey => {
      const dayItems = dailyGroups[dayKey];
      if (dayItems.length === 0) return;

      // Calculate averages
      const temps = dayItems.map((item: any) => item.main?.temp).filter((t: any) => t !== undefined);
      const feelsLike = dayItems.map((item: any) => item.main?.feels_like).filter((t: any) => t !== undefined);
      const humidity = dayItems.map((item: any) => item.main?.humidity).filter((h: any) => h !== undefined);
      const pressure = dayItems.map((item: any) => item.main?.pressure).filter((p: any) => p !== undefined);
      const windSpeed = dayItems.map((item: any) => item.wind?.speed).filter((w: any) => w !== undefined);

      // Find min/max temperatures
      const minTemp = Math.min(...temps);
      const maxTemp = Math.max(...temps);

      // Get the most common weather condition (or the one at noon if available)
      const noonItem = dayItems.find((item: any) => {
        const date = new Date(item.dt * 1000);
        return date.getHours() >= 12 && date.getHours() < 15;
      }) || dayItems[Math.floor(dayItems.length / 2)];

      // Create daily summary
      const dailySummary: any = {
        dt: dayItems[0].dt, // Use first item's timestamp for the day
        main: {
          temp: temps.reduce((a: number, b: number) => a + b, 0) / temps.length,
          feels_like: feelsLike.reduce((a: number, b: number) => a + b, 0) / feelsLike.length,
          temp_min: minTemp,
          temp_max: maxTemp,
          humidity: humidity.reduce((a: number, b: number) => a + b, 0) / humidity.length,
          pressure: pressure.reduce((a: number, b: number) => a + b, 0) / pressure.length
        },
        weather: noonItem.weather || dayItems[0].weather,
        wind: {
          speed: windSpeed.reduce((a: number, b: number) => a + b, 0) / windSpeed.length
        },
        _isDailySummary: true,
        _dayItems: dayItems // Keep original items for reference
      };

      dailyForecasts.push(dailySummary);
    });

    return dailyForecasts;
  }

  /**
   * Set forecast display mode
   */
  setForecastDisplayMode(mode: 'hourly' | 'daily'): void {
    this.forecastDisplayMode = mode;
    // Process data if we have forecast data available
    if (this.forecast) {
      this.processForecastData();
      this.updateTemperatureChart();
      this.cdr.detectChanges();
    }
  }

  /**
   * Get forecast display mode label
   */
  getForecastModeLabel(): string {
    switch (this.forecastDisplayMode) {
      case 'hourly':
        return this.translateService.instant('API.FORECAST_3H') || 'Toutes les 3 heures';
      case 'daily':
        return this.translateService.instant('API.FORECAST_DAILY') || 'Résumé quotidien';
      default:
        return '';
    }
  }

  /**
   * Update temperature chart with forecast data
   */
  private updateTemperatureChart(): void {
    const dataToUse = this.displayForecastList.length > 0 ? this.displayForecastList : 
                      (this.forecast?.list || []);

    if (dataToUse.length === 0) {
      return;
    }

    const labels: string[] = [];
    const temperatures: number[] = [];
    let firstDate: Date | null = null;
    let lastDate: Date | null = null;

    // Get current language for date formatting
    const currentLang = this.translateService.currentLang || 'fr-FR';

    dataToUse.forEach((item: any) => {
      if (item.dt && item.main?.temp !== undefined) {
        const date = new Date(item.dt * 1000);
        
        // Track first and last dates
        if (firstDate === null || date < firstDate) {
          firstDate = date;
        }
        if (lastDate === null || date > lastDate) {
          lastDate = date;
        }
        
        // Format date based on display mode
        let dateStr: string;
        if (this.forecastDisplayMode === 'hourly') {
          // Show date and time for hourly mode
          dateStr = date.toLocaleString(currentLang, {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          });
        } else {
          // Show only date for daily mode
          dateStr = date.toLocaleDateString(currentLang, {
            day: '2-digit',
            month: '2-digit',
            weekday: 'short'
          });
        }
        labels.push(dateStr);
        
        // For daily mode, show max temperature
        // For hourly modes, show current temperature
        const temp = this.forecastDisplayMode === 'daily' && item.main?.temp_max 
          ? item.main.temp_max 
          : item.main.temp;
        temperatures.push(Math.round(temp));
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
      
      // Update forecast section title with location (without "5 days" mention)
      if (this.forecastDisplayMode === 'daily') {
        // For daily mode, show date range
        this.forecastTitle = startStr === endStr 
          ? `${this.translateService.instant('API.FORECAST')} - ${location} - ${startStr}`
          : `${this.translateService.instant('API.FORECAST')} - ${location} ${startStr} ${this.translateService.instant('TO')} ${endStr}`;
      } else {
        // For 3-hour mode, show date range
        this.forecastTitle = startStr === endStr 
          ? `${this.translateService.instant('API.FORECAST')} - ${location} - ${startStr}`
          : `${this.translateService.instant('API.FORECAST')} - ${location} ${startStr} ${this.translateService.instant('TO')} ${endStr}`;
      }
      
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
   * Get altitude for display (from currentWeather or local alt variable)
   */
  getDisplayAltitude(): number | null {
    // First check if altitude is in currentWeather (from API response)
    if (this.currentWeather && this.currentWeather.altitude !== null && this.currentWeather.altitude !== undefined) {
      const alt = typeof this.currentWeather.altitude === 'number' 
        ? this.currentWeather.altitude 
        : parseFloat(String(this.currentWeather.altitude));
      if (!isNaN(alt)) {
        // Also update local alt for consistency
        this.alt = alt;
        return alt;
      }
    }
    // Fallback to local alt variable (from mobile device or Nominatim)
    if (this.alt !== null && this.alt !== undefined) {
      const altValue = typeof this.alt === 'number' ? this.alt : parseFloat(String(this.alt));
      return !isNaN(altValue) ? altValue : null;
    }
    return null;
  }

  /**
   * Fetch all available altitudes when coordinates are available
   */
  private fetchAllAltitudes(lat: number, lon: number): void {
    // Only send altitude to backend if it's really from mobile GPS
    // Otherwise, let backend fetch it from other sources
    const altToSend = this.altFromMobile ? this.alt : null;
    this.apiService.getAllAltitudes(lat, lon, altToSend).subscribe({
      next: (response) => {
        if (response.altitudes && Array.isArray(response.altitudes)) {
          this.allAltitudes = response.altitudes;
          // Update primary alt with highest priority (first in array)
          if (this.allAltitudes.length > 0) {
            this.alt = this.allAltitudes[0].altitude;
          }
          this.cdr.detectChanges();
        }
      },
      error: (error) => {
        console.debug('Could not fetch altitudes:', error);
      }
    });
  }

  /**
   * Get translated source description for altitude
   */
  getAltitudeSourceDescription(source: string): string {
    switch (source) {
      case 'mobile_device':
        return this.translateService.instant('API.ALTITUDE_FROM_MOBILE');
      case 'nominatim':
        return this.translateService.instant('API.ALTITUDE_FROM_NOMINATIM');
      case 'openelevation':
        return this.translateService.instant('API.ALTITUDE_FROM_OPENELEVATION');
      default:
        return source;
    }
  }

  /**
   * Calculate average altitude from all available altitudes
   */
  getAverageAltitude(): number | null {
    if (!this.allAltitudes || this.allAltitudes.length === 0) {
      return null;
    }
    if (this.allAltitudes.length === 1) {
      return this.allAltitudes[0].altitude;
    }
    const sum = this.allAltitudes.reduce((acc, altInfo) => acc + altInfo.altitude, 0);
    return sum / this.allAltitudes.length;
  }

  /**
   * Format coordinate to 10 decimals without trailing zeros
   */
  formatCoordinate(value: number | null | undefined): string {
    if (value === null || value === undefined || isNaN(value)) {
      return '';
    }
    // Round to 10 decimals and remove trailing zeros
    return parseFloat(value.toFixed(10)).toString();
  }

  /**
   * Parse coordinate value from string
   */
  parseCoordinate(value: string): number | null {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Get weather icon URL
   */
  getWeatherIconUrl(icon: string): string {
    if (!icon) return '';
    return `https://openweathermap.org/img/wn/${icon}@2x.png`;
  }

  /**
   * Get country flag emoji from country code
   */
  getCountryFlag(countryCode: string): string {
    if (!countryCode || countryCode.length !== 2) {
      return '';
    }
    
    // Convert country code to flag emoji
    // Each flag emoji is made of two regional indicator symbols
    const codePoints = countryCode
      .toUpperCase()
      .split('')
      .map(char => 127397 + char.charCodeAt(0));
    
    return String.fromCodePoint(...codePoints);
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
   * Share current weather with address and GPS coordinates
   */
  async shareCurrentWeather(): Promise<void> {
    if (!this.currentWeather || this.currentWeather.error) {
      this.errorMessage = this.translateService.instant('API.NO_CURRENT_WEATHER') || 'No current weather data available';
      this.clearMessages();
      return;
    }

    const location = `${this.city}, ${this.countryCode}`;
    const address = this.fullAddress || location;
    
    // Get best available altitude (average if available, otherwise display altitude)
    const avgAltitude = this.getAverageAltitude();
    const displayAltitude = this.getDisplayAltitude();
    const bestAltitude = avgAltitude !== null ? avgAltitude : (displayAltitude !== null ? displayAltitude : null);
    
    const coordinates = bestAltitude !== null
      ? `${this.lat}, ${this.lon}, ${bestAltitude.toFixed(1)}m`
      : `${this.lat}, ${this.lon}`;
    const temp = this.formatTemperature(this.currentWeather.main?.temp);
    const feelsLike = this.formatTemperature(this.currentWeather.main?.feels_like);
    const description = this.currentWeather.weather?.[0]?.description || '';
    const humidity = this.currentWeather.main?.humidity || 0;
    const windSpeed = this.currentWeather.wind?.speed || 0;
    const pressure = this.currentWeather.main?.pressure || 0;

    let shareText = `${this.translateService.instant('API.CURRENT_WEATHER')} - ${location}\n\n` +
      `${this.translateService.instant('API.TEMPERATURE')}: ${temp}\n` +
      `${this.translateService.instant('API.FEELS_LIKE')}: ${feelsLike}\n` +
      `${this.translateService.instant('API.DESCRIPTION')}: ${description}\n` +
      `${this.translateService.instant('API.HUMIDITY')}: ${humidity}%\n` +
      `${this.translateService.instant('API.WIND_SPEED')}: ${windSpeed} m/s\n` +
      `${this.translateService.instant('API.PRESSURE')}: ${pressure} hPa`;
    
    if (bestAltitude !== null) {
      shareText += `\n${this.translateService.instant('API.ALTITUDE')}: ${bestAltitude.toFixed(1)} m`;
    }
    
    shareText += `\n\n${this.translateService.instant('API.ADDRESS')}: ${address}\n` +
      `${this.translateService.instant('API.COORDINATES')}: ${coordinates}`;

    // Create composite image with text + chart (if available)
    const chartImage = await this.getChartAsImage();
    const compositeImage = await this.createCompositeImage(shareText, chartImage);
    
    // Share with image if available, otherwise just text
    await this.shareText(shareText, this.translateService.instant('API.SHARE_CURRENT_WEATHER') || 'Share Current Weather', compositeImage);
  }

  /**
   * Share forecast with address and GPS coordinates
   */
  async shareForecast(): Promise<void> {
    if (!this.forecast || this.forecast.error || !this.displayForecastList || this.displayForecastList.length === 0) {
      this.errorMessage = this.translateService.instant('API.NO_FORECAST_DATA') || 'No forecast data available';
      this.clearMessages();
      return;
    }

    const location = `${this.city}, ${this.countryCode}`;
    const address = this.fullAddress || location;
    
    // Get best available altitude (average if available, otherwise display altitude)
    const avgAltitude = this.getAverageAltitude();
    const displayAltitude = this.getDisplayAltitude();
    const bestAltitude = avgAltitude !== null ? avgAltitude : (displayAltitude !== null ? displayAltitude : null);
    
    const coordinates = bestAltitude !== null
      ? `${this.lat}, ${this.lon}, ${bestAltitude.toFixed(1)}m`
      : `${this.lat}, ${this.lon}`;
    const modeLabel = this.getForecastModeLabel();
    
    let forecastText = `${this.translateService.instant('API.FORECAST')} - ${location} (${modeLabel})\n\n`;

    // Add forecast items
    this.displayForecastList.slice(0, 10).forEach((item: any, index: number) => {
      const date = this.formatDate(item.dt);
      if (this.forecastDisplayMode === 'daily') {
        const tempMax = this.formatTemperature(item.main?.temp_max);
        const tempMin = this.formatTemperature(item.main?.temp_min);
        const desc = item.weather?.[0]?.description || '';
        forecastText += `${date}: ${tempMax} / ${tempMin} - ${desc}\n`;
      } else {
        const temp = this.formatTemperature(item.main?.temp);
        const desc = item.weather?.[0]?.description || '';
        forecastText += `${date}: ${temp} - ${desc}\n`;
      }
    });

    forecastText += `\n${this.translateService.instant('API.ADDRESS')}: ${address}\n` +
      `${this.translateService.instant('API.COORDINATES')}: ${coordinates}`;
    
    if (bestAltitude !== null) {
      forecastText += `\n${this.translateService.instant('API.ALTITUDE')}: ${bestAltitude.toFixed(1)} m`;
    }

    // Create composite image with text first, then chart
    const chartImage = await this.getChartAsImage();
    const compositeImage = await this.createCompositeImage(forecastText, chartImage);
    
    // Share with image if available, otherwise just text
    await this.shareText(forecastText, this.translateService.instant('API.SHARE_FORECAST') || 'Share Forecast', compositeImage);
  }

  /**
   * Get chart as image (base64 data URL)
   */
  private async getChartAsImage(): Promise<string | null> {
    if (!this.chart || !this.chart.chart) {
      console.log('Chart not available for image capture');
      return null;
    }

    try {
      const canvas = this.chart.chart.canvas;
      if (!canvas) {
        console.log('Chart canvas not available');
        return null;
      }

      // Wait a bit to ensure chart is fully rendered
      await new Promise(resolve => setTimeout(resolve, 100));

      // Convert canvas to image with high quality
      const imageDataUrl = canvas.toDataURL('image/png', 1.0);
      
      // Verify the image was created (should start with 'data:image')
      if (!imageDataUrl || !imageDataUrl.startsWith('data:image')) {
        console.warn('Failed to create valid image data URL from chart');
        return null;
      }
      
      return imageDataUrl;
    } catch (error) {
      console.warn('Failed to get chart as image:', error);
      return null;
    }
  }

  /**
   * Create composite image with text and chart
   */
  private async createCompositeImage(text: string, chartImageUrl: string | null): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        // Create a canvas for the composite image
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }

        const padding = 20;
        const lineHeight = 24;
        const maxWidth = 800;
        let currentY = padding;

        // Calculate text dimensions
        ctx.font = '16px Arial';
        const lines = this.wrapText(ctx, text, maxWidth - 2 * padding);
        const textHeight = lines.length * lineHeight;

        // Load chart image if available
        if (chartImageUrl) {
          const chartImg = new Image();
          chartImg.crossOrigin = 'anonymous';
          chartImg.onload = () => {
            const chartWidth = Math.min(chartImg.width, maxWidth);
            const chartHeight = (chartImg.height * chartWidth) / chartImg.width;

            // Set canvas size
            canvas.width = maxWidth;
            canvas.height = textHeight + chartHeight + 3 * padding;

            // Fill white background
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Draw text
            ctx.fillStyle = '#000000';
            ctx.font = '16px Arial';
            currentY = padding + lineHeight;
            lines.forEach((line: string) => {
              ctx.fillText(line, padding, currentY);
              currentY += lineHeight;
            });

            // Draw chart image below text
            currentY += padding;
            ctx.drawImage(chartImg, padding, currentY, chartWidth, chartHeight);

            // Convert to data URL
            const compositeImageUrl = canvas.toDataURL('image/png');
            resolve(compositeImageUrl);
          };
          chartImg.onerror = () => {
            // If chart image fails to load, create image with text only
            canvas.width = maxWidth;
            canvas.height = textHeight + 2 * padding;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#000000';
            ctx.font = '16px Arial';
            currentY = padding + lineHeight;
            lines.forEach((line: string) => {
              ctx.fillText(line, padding, currentY);
              currentY += lineHeight;
            });
            resolve(canvas.toDataURL('image/png'));
          };
          chartImg.src = chartImageUrl;
        } else {
          // No chart, just text
          canvas.width = maxWidth;
          canvas.height = textHeight + 2 * padding;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#000000';
          ctx.font = '16px Arial';
          currentY = padding + lineHeight;
          lines.forEach((line: string) => {
            ctx.fillText(line, padding, currentY);
            currentY += lineHeight;
          });
          resolve(canvas.toDataURL('image/png'));
        }
      } catch (error) {
        console.warn('Failed to create composite image:', error);
        resolve(null);
      }
    });
  }

  /**
   * Wrap text to fit within max width
   */
  private wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const words = text.split('\n');
    const lines: string[] = [];

    words.forEach((word: string) => {
      if (word.trim() === '') {
        lines.push('');
        return;
      }

      const testLine = word;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth) {
        // Split long lines
        let currentLine = '';
        const chars = word.split('');
        chars.forEach((char: string) => {
          const testChar = currentLine + char;
          const charMetrics = ctx.measureText(testChar);
          if (charMetrics.width > maxWidth && currentLine.length > 0) {
            lines.push(currentLine);
            currentLine = char;
          } else {
            currentLine += char;
          }
        });
        if (currentLine.length > 0) {
          lines.push(currentLine);
        }
      } else {
        lines.push(testLine);
      }
    });

    return lines;
  }

  /**
   * Convert data URL to blob
   */
  private dataURLtoBlob(dataURL: string): Blob {
    const arr = dataURL.split(',');
    const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/png';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  }

  /**
   * Copy image to clipboard (if supported)
   */
  private async copyImageToClipboard(imageDataUrl: string): Promise<boolean> {
    try {
      const blob = this.dataURLtoBlob(imageDataUrl);
      const clipboardItem = new ClipboardItem({ 'image/png': blob });
      if (navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([clipboardItem]);
        return true;
      }
    } catch (error) {
      console.log('Could not copy image to clipboard:', error);
    }
    return false;
  }

  /**
   * Share text using Web Share API or copy to clipboard
   * Optionally includes an image (composite with text + chart)
   */
  private async shareText(text: string, title: string, imageDataUrl?: string | null): Promise<void> {
    // Try Web Share API first (works on mobile)
    if (navigator.share) {
      try {
        // If we have an image, try to share it as a file
        if (imageDataUrl) {
          try {
            // Convert data URL to blob using proper conversion method
            const blob = this.dataURLtoBlob(imageDataUrl);
            const file = new File([blob], 'weather-forecast.png', { type: 'image/png' });
            
            // Check if files can be shared
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              // Share with both text and image file
              await navigator.share({
                title: title,
                text: text,
                files: [file]
              });
              this.successMessage = this.translateService.instant('API.SHARED_SUCCESSFULLY') || 'Shared successfully';
              this.clearMessages();
              return;
            } else {
              // Files can't be shared, try to copy image to clipboard first
              const imageCopied = await this.copyImageToClipboard(imageDataUrl);
              const imageNote = imageCopied 
                ? '\n\n' + (this.translateService.instant('API.IMAGE_COPIED_TO_CLIPBOARD') || 'Image copied to clipboard - you can paste it in your message')
                : '';
              
              // Try to share with URL containing image data (some apps might support it)
              console.log('File sharing not supported, trying with data URL in URL field');
              try {
                await navigator.share({
                  title: title,
                  text: text + imageNote,
                  url: imageDataUrl
                });
                this.successMessage = this.translateService.instant('API.SHARED_SUCCESSFULLY') || 'Shared successfully';
                this.clearMessages();
                return;
              } catch (urlError) {
                console.log('Sharing with URL field failed, sharing text with image note:', urlError);
                // Share text with note about image
                await navigator.share({
                  title: title,
                  text: text + imageNote
                });
                this.successMessage = this.translateService.instant('API.SHARED_SUCCESSFULLY') || 'Shared successfully';
                this.clearMessages();
                return;
              }
            }
          } catch (error) {
            console.log('Could not share image file, trying to copy to clipboard and share text:', error);
            // Try to copy image to clipboard
            const imageCopied = await this.copyImageToClipboard(imageDataUrl);
            const imageNote = imageCopied 
              ? '\n\n' + (this.translateService.instant('API.IMAGE_COPIED_TO_CLIPBOARD') || 'Image copied to clipboard - you can paste it in your message')
              : '';
            
            // Share text with note about image
            await navigator.share({
              title: title,
              text: text + imageNote
            });
            this.successMessage = this.translateService.instant('API.SHARED_SUCCESSFULLY') || 'Shared successfully';
            this.clearMessages();
            return;
          }
        }

        // Share text only (works with WhatsApp on mobile)
        await navigator.share({
          title: title,
          text: text
        });
        this.successMessage = this.translateService.instant('API.SHARED_SUCCESSFULLY') || 'Shared successfully';
        this.clearMessages();
        return;
      } catch (error: any) {
        // User cancelled or error occurred, fall back to clipboard
        if (error.name !== 'AbortError') {
          console.log('Web Share API failed, using clipboard:', error);
          this.copyWeatherToClipboard(text, imageDataUrl);
        }
      }
    } else {
      // No Web Share API (PC), use clipboard with image data URL
      this.copyWeatherToClipboard(text, imageDataUrl);
    }
  }

  /**
   * Copy weather to clipboard (fallback method, like copyToClipboard for position)
   * On PC, includes image data URL so user can save it
   */
  private async copyWeatherToClipboard(text: string, imageDataUrl?: string | null): Promise<void> {
    try {
      let textToCopy = text;
      
      if (imageDataUrl) {
        // On PC, include image data URL so user can save it
        textToCopy += '\n\n' + (this.translateService.instant('API.IMAGE_DATA_URL') || 'Image data URL:') + '\n' + imageDataUrl;
      }
      
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(textToCopy);
        this.successMessage = this.translateService.instant('API.COPIED_TO_CLIPBOARD') || 'Copied to clipboard';
        this.clearMessages();
      } else {
        // Fallback for older browsers - show dialog
        this.showShareDialog(text, imageDataUrl);
      }
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      // Fallback: show dialog
      this.showShareDialog(text, imageDataUrl);
    }
  }

  /**
   * Show share dialog (fallback when Web Share API and clipboard are not available)
   * Similar to showPositionShareDialog
   */
  private showShareDialog(text: string, imageDataUrl?: string | null): void {
    let message = text;
    
    if (imageDataUrl) {
      message += '\n\n' + (this.translateService.instant('API.IMAGE_DATA_URL') || 'Image data URL:') + '\n' + imageDataUrl;
    }
    
    message += '\n\n' + (this.translateService.instant('API.COPY_MANUALLY') || 'Copy the text above manually');

    window.prompt(
      this.translateService.instant('API.SHARE_WEATHER') || 'Share Weather',
      message
    );
  }


  /**
   * Load user's location and set as default coordinates
   */
  private loadUserLocation(): void {
    this.getUserLocation().then((location) => {
      this.lat = location.lat;
      this.lon = location.lng;
      this.alt = location.alt || null;
      this.altFromMobile = (location as any).fromMobile || false; // Track if altitude is from mobile GPS
      this.lastLat = location.lat;
      this.lastLon = location.lng;
      // Fetch all altitudes from backend
      this.fetchAllAltitudes(location.lat, location.lng);
      // Get city and country code from coordinates (title will be updated in the callback)
      this.getCityFromCoordinates(location.lat, location.lng);
    }).catch(() => {
      // Keep default values if location cannot be obtained
      console.log('Using default coordinates (Paris)');
      this.lastLat = this.lat;
      this.lastLon = this.lon;
      this.alt = null;
      // Fetch all altitudes from backend even with default coordinates
      this.fetchAllAltitudes(this.lat, this.lon);
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
      this.alt = location.alt || null;
      this.altFromMobile = (location as any).fromMobile || false; // Track if altitude is from mobile GPS
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
   * Search for city using Nominatim and get GPS coordinates
   */
  searchCityAndGetCoordinates(): void {
    if (!this.city || this.city.trim().length === 0) {
      this.errorMessage = this.translateService.instant('API.CITY_REQUIRED') || 'City name is required';
      this.clearMessages();
      return;
    }

    this.isLoadingCitySearch = true;
    this.errorMessage = '';
    this.successMessage = '';
    this.citySearchResults = [];
    this.showCitySearchResults = false;

    // Build query: city name + optional country code
    let query = this.city.trim();
    if (this.countryCode && this.countryCode.trim().length > 0) {
      query += ', ' + this.countryCode.trim();
    }

    // Use Nominatim (OpenStreetMap) for forward geocoding - free and no API key required
    // Increase limit to get multiple results
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=10&addressdetails=1`;
    
    fetch(url, {
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
      if (data && Array.isArray(data) && data.length > 0) {
        // Store all results
        this.citySearchResults = data.map((result: any) => {
          const address = result.address || {};
          const cityName = address.city || address.town || address.village || 
                          address.municipality || address.county || result.display_name?.split(',')[0] || '';
          const country = address.country || '';
          const countryCode = address.country_code ? address.country_code.toUpperCase() : '';
          const state = address.state || address.region || '';
          const postcode = address.postcode || '';
          const road = address.road || '';
          const houseNumber = address.house_number || '';
          
          // Build display name
          const displayParts: string[] = [];
          if (cityName) displayParts.push(cityName);
          if (state) displayParts.push(state);
          if (country) displayParts.push(country);
          const displayName = displayParts.length > 0 ? displayParts.join(', ') : result.display_name || '';
          
          // Build detailed address
          const addressParts: string[] = [];
          if (houseNumber && road) {
            addressParts.push(`${road} ${houseNumber}`);
          } else if (road) {
            addressParts.push(road);
          }
          if (postcode) {
            addressParts.push(postcode);
          }
          if (cityName) {
            addressParts.push(cityName);
          }
          if (state) {
            addressParts.push(state);
          }
          if (country) {
            addressParts.push(country);
          }
          const detailedAddress = addressParts.length > 0 ? addressParts.join(', ') : result.display_name || '';
          
          return {
            lat: parseFloat(result.lat),
            lon: parseFloat(result.lon),
            displayName: displayName,
            cityName: cityName,
            country: country,
            countryCode: countryCode,
            state: state,
            postcode: postcode,
            road: road,
            houseNumber: houseNumber,
            detailedAddress: detailedAddress,
            fullAddress: result.display_name || displayName,
            originalResult: result
          };
        });
        
        // Show the results dropdown
        this.showCitySearchResults = true;
        this.isLoadingCitySearch = false;
        this.cdr.detectChanges();
      } else {
        this.errorMessage = this.translateService.instant('API.CITY_NOT_FOUND') || `City not found: ${this.city}`;
        this.isLoadingCitySearch = false;
        this.showCitySearchResults = false;
        this.clearMessages();
      }
    })
    .catch(error => {
      console.error('Error searching city:', error);
      this.errorMessage = 'Error searching city: ' + (error.message || 'Unknown error');
      this.isLoadingCitySearch = false;
      this.showCitySearchResults = false;
      this.clearMessages();
      this.cdr.detectChanges();
    });
  }

  /**
   * Select a city from search results
   */
  selectCityFromResults(selectedResult: any): void {
    if (!selectedResult) {
      return;
    }

    // Update coordinates
    this.lat = selectedResult.lat;
    this.lon = selectedResult.lon;
    this.lastLat = this.lat;
    this.lastLon = this.lon;
    
    // Update city name and country code
    if (selectedResult.cityName) {
      this.city = selectedResult.cityName;
    }
    if (selectedResult.countryCode) {
      this.countryCode = selectedResult.countryCode;
    }
    
    // Reset weather data
    this.currentWeather = null;
    this.forecast = null;
    this.forecastTitle = '';
    
    // Hide results dropdown
    this.showCitySearchResults = false;
    this.citySearchResults = [];
    
    // Get full address from coordinates (using Nominatim reverse geocoding)
    this.getFullAddressFromCoordinates(this.lat, this.lon).finally(() => {
      this.successMessage = this.translateService.instant('API.COORDINATES_FOUND') || 'Coordinates found';
      this.clearMessages();
      this.cdr.detectChanges();
    });
  }

  /**
   * Close city search results dropdown
   */
  closeCitySearchResults(): void {
    this.showCitySearchResults = false;
    this.citySearchResults = [];
  }

  /**
   * Get city and country code from coordinates using reverse geocoding
   */
  private getCityFromCoordinates(lat: number, lon: number): void {
    this.apiService.getCurrentWeatherByCoordinates(lat, lon, this.alt).subscribe({
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
   * Also extracts altitude from the same response to avoid duplicate API calls
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
      
      // Extract altitude from Nominatim response if available (to avoid duplicate API call)
      // Note: Nominatim typically does NOT provide elevation data, but we check anyway
      // Only update if we don't already have altitude from mobile device
      if (this.alt === null || this.alt === undefined) {
        if (data && data.extratags && data.extratags.ele) {
          try {
            const elevation = parseFloat(data.extratags.ele);
            if (!isNaN(elevation)) {
              this.alt = elevation;
              this.altFromMobile = false; // Not from mobile, from Nominatim
            }
          } catch (e) {
            // Could not parse elevation from Nominatim extratags.ele
          }
        } else if (data && data.elevation) {
          try {
            const elevation = typeof data.elevation === 'number' ? data.elevation : parseFloat(data.elevation);
            if (!isNaN(elevation)) {
              this.alt = elevation;
              this.altFromMobile = false; // Not from mobile, from Nominatim
            }
          } catch (e) {
            // Could not parse elevation from Nominatim elevation field
          }
        }
      }
      
      // Fetch all altitudes from backend
      this.fetchAllAltitudes(lat, lon);
      
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
  private getUserLocation(): Promise<{ lat: number; lng: number; alt?: number | null }> {
    return new Promise((resolve, reject) => {
      // Try GPS first (more accurate)
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            // Capture altitude if available from mobile device
            // Note: On PC, altitude is usually null or inaccurate
            const altitude = position.coords.altitude !== null && !isNaN(position.coords.altitude) 
              ? position.coords.altitude 
              : null;
            resolve({
              lat: position.coords.latitude,
              lng: position.coords.longitude,
              alt: altitude,
              fromMobile: altitude !== null // Only true if we actually got altitude from GPS
            } as any);
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
   * Handle location selected from trace viewer
   */
  onLocationSelected(location: { lat: number; lng: number; alt?: number | null }): void {
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
    this.alt = location.alt || null;
    
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
    this.apiService.getCurrentWeatherByCoordinates(lat, lon, this.alt).subscribe({
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

    // Check if coordinates are valid
    if (this.lat == null || this.lon == null || isNaN(this.lat) || isNaN(this.lon)) {
      this.errorMessage = this.translateService.instant('API.ERROR_GETTING_LOCATION');
      this.clearMessages();
      return;
    }

    // Use current coordinates from the component (lat/lon fields)
    const initialLat = this.lat;
    const initialLon = this.lon;
    const label = `${initialLat.toFixed(6)}, ${initialLon.toFixed(6)}`;
    // Open at location with coordinates, disable selection mode (just display), simple share mode
    this.traceViewerModalComponent.openAtLocation(initialLat, initialLon, label, undefined, false, true);
  }

  /**
   * Share the current position (latitude and longitude)
   */
  sharePosition(): void {
    // Use toFixed(6) to ensure sufficient precision for GPS coordinates (6 decimals = ~0.11m accuracy)
    const latStr = this.lat.toFixed(6);
    const lonStr = this.lon.toFixed(6);
    
    // Get best available altitude (average if available, otherwise display altitude)
    const avgAltitude = this.getAverageAltitude();
    const displayAltitude = this.getDisplayAltitude();
    const bestAltitude = avgAltitude !== null ? avgAltitude : (displayAltitude !== null ? displayAltitude : null);
    
    const altStr = bestAltitude !== null ? `, ${bestAltitude.toFixed(1)}m` : '';
    const positionText = `${latStr}, ${lonStr}${altStr}`;
    const googleMapsUrl = `https://www.google.com/maps?q=${latStr},${lonStr}`;
    
    let shareText = `${this.translateService.instant('API.POSITION')}: ${positionText}\n${this.translateService.instant('API.VIEW_ON_MAPS')}: ${googleMapsUrl}`;
    
    if (bestAltitude !== null) {
      shareText += `\n${this.translateService.instant('API.ALTITUDE')}: ${bestAltitude.toFixed(1)} m`;
    }

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

  /**
   * Paste coordinates from clipboard in format "lat, lng" and update lat/lon fields
   */
  pasteCoordinates(): void {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then((text) => {
        this.parseAndSetCoordinates(text);
      }).catch((error) => {
        console.error('Failed to read from clipboard:', error);
        // Fallback: show prompt to paste manually
        const pastedText = window.prompt(this.translateService.instant('API.PASTE_COORDINATES'));
        if (pastedText) {
          this.parseAndSetCoordinates(pastedText);
        }
      });
    } else {
      // Fallback: show prompt to paste manually
      const pastedText = window.prompt(this.translateService.instant('API.PASTE_COORDINATES'));
      if (pastedText) {
        this.parseAndSetCoordinates(pastedText);
      }
    }
  }

  /**
   * Parse coordinates from text in format "lat, lng" and set lat/lon
   */
  private parseAndSetCoordinates(text: string): void {
    if (!text || !text.trim()) {
      return;
    }

    // Remove extra whitespace and split by comma
    const parts = text.trim().split(',').map(part => part.trim());
    
    if (parts.length >= 2) {
      const latValue = parseFloat(parts[0]);
      const lonValue = parseFloat(parts[1]);
      
      if (!isNaN(latValue) && !isNaN(lonValue)) {
        this.lat = latValue;
        this.lon = lonValue;
        this.successMessage = this.translateService.instant('API.COORDINATES_UPDATED', { lat: latValue, lon: lonValue });
        this.clearMessages();
        this.cdr.detectChanges();
        
        // Get full address from coordinates (using Nominatim)
        // This will update city, countryCode, fullAddress and currentWeatherTitle
        this.getFullAddressFromCoordinates(latValue, lonValue);
      } else {
        this.errorMessage = this.translateService.instant('API.INVALID_COORDINATES');
        this.clearMessages();
      }
    } else {
      this.errorMessage = this.translateService.instant('API.INVALID_COORDINATES');
      this.clearMessages();
    }
  }
}
