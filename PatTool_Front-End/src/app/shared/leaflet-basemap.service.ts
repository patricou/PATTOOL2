import { Injectable } from '@angular/core';
import * as L from 'leaflet';
import { take } from 'rxjs';
import { ApiService } from '../services/api.service';

export interface LeafletBasemapOption {
  id: string;
  label: string;
  labelKey?: string;
}

type BasemapFactory = () => L.TileLayer | L.LayerGroup;

/** Shared Leaflet base maps (same catalogue as trace viewer). */
@Injectable({ providedIn: 'root' })
export class LeafletBasemapService {

  private static readonly SWISSTOPO_ATTRIBUTION =
    '&copy; <a href="https://www.swisstopo.admin.ch/">swisstopo</a>';

  private static readonly SWISSTOPO_BASEMAP_IDS = new Set([
    'swisstopo-pixelkarte',
    'swisstopo-swissimage',
  ]);

  private layerFactories: Record<string, BasemapFactory> = {};
  private availableBaseLayers: LeafletBasemapOption[] = [];
  private initialized = false;
  private optionalLayersLoaded = false;
  private thunderforestApiKey = '';
  private ignApiKey = '';

  getAvailableLayers(): LeafletBasemapOption[] {
    this.ensureInitialized();
    return [...this.availableBaseLayers];
  }

  isValidLayerId(layerId: string): boolean {
    this.ensureInitialized();
    if (LeafletBasemapService.SWISSTOPO_BASEMAP_IDS.has(layerId)) {
      return true;
    }
    return !!this.layerFactories[layerId];
  }

  /** Load Thunderforest / IGN SCAN25 optional layers when API keys exist. */
  loadOptionalLayers(apiService: ApiService): void {
    if (this.optionalLayersLoaded) {
      return;
    }
    this.optionalLayersLoaded = true;
    this.ensureInitialized();

    apiService.getIgnApiKey().pipe(take(1)).subscribe({
      next: (apiKey) => {
        if (!apiKey?.trim()) {
          return;
        }
        this.ignApiKey = apiKey.trim();
        this.layerFactories['ign-classic'] = () => this.createIgnClassicLayer();
      },
      error: () => { /* optional */ },
    });

    apiService.getThunderforestApiKey().pipe(take(1)).subscribe({
      next: (apiKey) => {
        if (!apiKey?.trim()) {
          return;
        }
        this.thunderforestApiKey = apiKey.trim();
        this.layerFactories['opencyclemap'] = () => this.createOpenCycleMapLayer();
        this.layerFactories['thunderforest-outdoors'] = () => this.createThunderforestOutdoorsLayer();
        if (!this.availableBaseLayers.some((layer) => layer.id === 'opencyclemap')) {
          this.availableBaseLayers.push({ id: 'opencyclemap', label: 'OpenCycleMap' });
          this.availableBaseLayers.push({ id: 'thunderforest-outdoors', label: 'TF Outdoors' });
          this.availableBaseLayers.sort((a, b) => a.label.localeCompare(b.label));
        }
      },
      error: () => { /* optional */ },
    });
  }

  applyBaseLayer(
    map: L.Map,
    layerId: string,
    activeLayer: L.TileLayer | L.LayerGroup | null | undefined
  ): L.TileLayer | L.LayerGroup | null {
    this.ensureInitialized();
    const resolvedId = this.isValidLayerId(layerId) ? layerId : 'osm-standard';

    if (activeLayer) {
      map.removeLayer(activeLayer);
    }

    const nextLayer = this.createLayerInstance(resolvedId);
    if (!nextLayer) {
      return null;
    }

    nextLayer.addTo(map);
    this.bringBasemapToBack(nextLayer);
    requestAnimationFrame(() => map.invalidateSize());
    return nextLayer;
  }

  private ensureInitialized(): void {
    if (this.initialized) {
      return;
    }
    this.createBaseLayers();
    this.initialized = true;
  }

  /** Each map needs its own layer instances — Leaflet layers cannot be shared across maps. */
  private createLayerInstance(layerId: string): L.TileLayer | L.LayerGroup | null {
    if (LeafletBasemapService.SWISSTOPO_BASEMAP_IDS.has(layerId)) {
      return this.createSwisstopoLayer(layerId);
    }
    const factory = this.layerFactories[layerId] ?? this.layerFactories['osm-standard'];
    return factory ? factory() : null;
  }

  private bringBasemapToBack(layer: L.TileLayer | L.LayerGroup): void {
    if (layer instanceof L.TileLayer) {
      layer.bringToBack();
      return;
    }
    layer.eachLayer((child) => {
      if (child instanceof L.TileLayer) {
        child.bringToBack();
      }
    });
  }

  private createSwisstopoLayer(layerId: string): L.TileLayer {
    const isImage = layerId === 'swisstopo-swissimage';
    return L.tileLayer(
      isImage
        ? 'https://wmts{s}.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'
        : 'https://wmts{s}.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg',
      {
        subdomains: '0123456789',
        maxZoom: isImage ? 19 : 18,
        minZoom: 2,
        attribution: LeafletBasemapService.SWISSTOPO_ATTRIBUTION,
      }
    );
  }

  private createIgnClassicLayer(): L.LayerGroup {
    const scanRegional = L.tileLayer(
      'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=IGNF_CARTES_SCAN-REGIONAL&STYLE=SCANREG&FORMAT=image/jpeg&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}',
      { minZoom: 0, maxZoom: 12, attribution: '&copy; IGN - Géoportail', zIndex: 1 }
    );
    const planIgn = L.tileLayer(
      'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}',
      { minZoom: 12, maxZoom: 19, attribution: '&copy; IGN - Géoportail', zIndex: 2 }
    );
    const layers: L.Layer[] = [scanRegional, planIgn];
    if (this.ignApiKey) {
      layers.push(L.tileLayer(
        'https://data.geopf.fr/private/wmts?apikey=' + encodeURIComponent(this.ignApiKey) +
        '&REQUEST=GetTile&SERVICE=WMTS&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.MAPS.SCAN25TOUR&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
        {
          minZoom: 13,
          maxZoom: 19,
          attribution: '&copy; IGN - Géoportail',
          zIndex: 3,
        }
      ));
    }
    return L.layerGroup(layers);
  }

  private createOpenCycleMapLayer(): L.TileLayer {
    return L.tileLayer(
      'https://{s}.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=' + this.thunderforestApiKey,
      {
        maxZoom: 18,
        subdomains: ['a', 'b', 'c'],
        attribution: '&copy; OpenStreetMap contributors, &copy; Thunderforest',
      }
    );
  }

  private createThunderforestOutdoorsLayer(): L.TileLayer {
    return L.tileLayer(
      'https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=' + this.thunderforestApiKey,
      {
        maxZoom: 18,
        subdomains: ['a', 'b', 'c'],
        attribution: '&copy; OpenStreetMap contributors, &copy; Thunderforest',
      }
    );
  }

  private createBaseLayers(): void {
    this.layerFactories = {
      'osm-standard': () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }),
      'osm-fr': () => {
        const osmStandardBase = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 20,
          attribution: '&copy; OpenStreetMap contributors',
          opacity: 0.7,
          zIndex: 1,
        });
        const osmFrance = L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
          maxZoom: 20,
          minZoom: 0,
          subdomains: ['a', 'b', 'c'],
          attribution: '&copy; OpenStreetMap France & OSM contributors',
          tileSize: 256,
          zIndex: 2,
        });
        return L.layerGroup([osmStandardBase, osmFrance]);
      },
      'esri-imagery': () => L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, attribution: 'Tiles &copy; Esri' }
      ),
      'opentopomap': () => L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 17,
        subdomains: 'abc',
        attribution: 'Map data: &copy; OSM contributors, SRTM',
      }),
      'ign-plan': () => L.tileLayer(
        'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}',
        { maxZoom: 19, attribution: '&copy; IGN - Géoportail' }
      ),
      'ign-classic': () => this.createIgnClassicLayer(),
      'ign-ortho': () => L.tileLayer(
        'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}',
        { maxZoom: 19, attribution: '&copy; IGN - Géoportail' }
      ),
      'ign-cadastre': () => L.tileLayer(
        'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=CADASTRALPARCELS.PARCELLAIRE_EXPRESS&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}',
        { maxZoom: 19, attribution: '&copy; IGN - Géoportail' }
      ),
      'ign-topo': () => L.tileLayer(
        'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}',
        { maxZoom: 19, attribution: '&copy; IGN - Géoportail' }
      ),
      'cyclosm': () => L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
        maxZoom: 18,
        subdomains: 'abc',
        attribution: '&copy; CyclOSM | &copy; OpenStreetMap',
      }),
      'swisstopo-pixelkarte': () => L.layerGroup(),
      'swisstopo-swissimage': () => L.layerGroup(),
    };

    this.availableBaseLayers = [
      { id: 'osm-standard', label: 'OpenStreetMap' },
      { id: 'osm-fr', label: 'OSM France' },
      { id: 'esri-imagery', label: 'Esri Satellite' },
      { id: 'opentopomap', label: 'OpenTopoMap' },
      { id: 'ign-classic', label: 'IGN Classique' },
      { id: 'ign-plan', label: 'IGN Plan' },
      { id: 'ign-ortho', label: 'IGN Ortho' },
      { id: 'ign-cadastre', label: 'IGN Cadastre' },
      { id: 'ign-topo', label: 'IGN Topo' },
      { id: 'cyclosm', label: 'CyclOSM' },
      { id: 'swisstopo-pixelkarte', label: 'Swiss Topo', labelKey: 'EVENTELEM.SWISSSTOPO_PIXELKARTE' },
      { id: 'swisstopo-swissimage', label: 'SWISSIMAGE', labelKey: 'EVENTELEM.SWISSSTOPO_SWISSIMAGE' },
    ].sort((a, b) => a.label.localeCompare(b.label));
  }
}
