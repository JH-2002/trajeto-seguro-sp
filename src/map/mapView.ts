import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MlMap,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { HexagonLayer } from '@deck.gl/aggregation-layers';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { CONFIG } from '../config';
import type { AccidentPoint, AvoidedSegment, LightPoint, LngLat, MapPoint, ScoredRoute } from '../types';
import { boundsOf, lineLength, haversine } from '../utils/geo';

export interface LayerVisibility {
  heat: boolean;
  columns: boolean;
  accidents: boolean;
  buildings: boolean;
  lights: boolean;
}

export interface RouteDisplay {
  routes: ScoredRoute[];
  safestId: string;
  fastestId: string;
  selectedId: string;
}

interface Trip {
  path: LngLat[];
  timestamps: number[];
}

const BUILDINGS_LAYER_ID = 'ts-buildings-3d';
const HEAT_SOURCE_ID = 'ts-crime-heat';
const HEAT_LAYER_ID = 'ts-crime-heat';
const LIGHT_SOURCE_ID = 'ts-lights';
const LIGHT_LAYER_ID = 'ts-lights';
const TRIP_LOOP = 1000;
const TRIP_TRAIL = 180;
/** A animação da rota toca uma vez e para, para não redesenhar o mapa sem fim. */
const TRIP_DURATION_MS = 3000;
/** Agrupamento dos pontos do calor (~275 m): menos pontos e manchas mais suaves. */
const HEAT_CELL_DEG = 0.0025;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export class MapView {
  readonly map: MlMap;
  private readonly overlay: MapboxOverlay;
  private styleReady = false;
  private lite = false;
  private firstLabelLayer: string | undefined;
  private crimes: MapPoint[] = [];
  private heatData: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  private heatMax = 1;
  private accidents: AccidentPoint[] = [];
  private lightData: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  private inspect: { center: LngLat; radiusM: number } | null = null;
  private avoided: AvoidedSegment[] = [];
  private routeDisplay: RouteDisplay | null = null;
  private trip: Trip | null = null;
  private tripTime = 0;
  private animFrame = 0;
  private orbitFrame = 0;
  private columnsScale = 0;
  private markers: { origin?: maplibregl.Marker; destination?: maplibregl.Marker } = {};
  visibility: LayerVisibility = { heat: true, columns: false, accidents: false, buildings: true, lights: false };

  constructor(container: HTMLElement) {
    this.map = new maplibregl.Map({
      container,
      style: CONFIG.mapStyle,
      center: CONFIG.initialView.center,
      zoom: CONFIG.initialView.zoom - 1.2,
      pitch: 0,
      bearing: 0,
      maxPitch: CONFIG.performance.maxPitch,
      pixelRatio: Math.min(window.devicePixelRatio || 1, CONFIG.performance.pixelRatioCap),
      attributionControl: { compact: true },
      // Antialias custa caro em telas grandes; o ganho visual aqui é pequeno.
      canvasContextAttributes: { antialias: false },
      fadeDuration: 150,
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

    this.overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      getTooltip: (info) => this.tooltip(info),
    });
    this.map.addControl(this.overlay);

    this.map.on('load', () => {
      this.firstLabelLayer = this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
      this.styleLabels();
      this.addBuildings();
      this.addHeat();
      this.addLights();
      this.addHorizonFog();
      this.applyTileLod();
      this.watchFrameRate();
      this.styleReady = true;
      this.render();
      this.map.flyTo({ ...CONFIG.initialView, duration: 2400, essential: true });
      window.setTimeout(() => {
        this.columnsScale = 1;
        this.render();
      }, 900);
    });
    for (const ev of ['mousedown', 'touchstart', 'wheel'] as const) this.map.on(ev, () => this.stopOrbit());
  }

  // ---------- dados ----------

  setCrimes(points: MapPoint[]): void {
    this.crimes = points;
    this.buildHeatData();
    this.updateHeat();
    this.render();
  }

  setAccidents(points: AccidentPoint[]): void {
    this.accidents = points;
    this.render();
  }

  setLights(points: LightPoint[]): void {
    this.lightData = {
      type: 'FeatureCollection',
      features: points.map((p) => ({ type: 'Feature', properties: { n: p.n }, geometry: { type: 'Point', coordinates: p.position } })),
    };
    if (this.styleReady) (this.map.getSource(LIGHT_SOURCE_ID) as GeoJSONSource | undefined)?.setData(this.lightData);
  }

  /** Círculo da área inspecionada (null remove). */
  setInspect(center: LngLat | null, radiusM = 300): void {
    this.inspect = center ? { center, radiusM } : null;
    this.render();
  }

  /** Trechos da rota mais rápida que a rota sugerida evita. */
  setAvoided(segments: AvoidedSegment[]): void {
    this.avoided = segments;
    this.render();
  }

  flyTo(center: LngLat, zoom = 15): void {
    this.map.flyTo({ center, zoom: Math.max(this.map.getZoom(), zoom), duration: 1200 });
  }

  setVisibility(v: Partial<LayerVisibility>): void {
    this.visibility = { ...this.visibility, ...v };
    if (this.styleReady) {
      this.map.setLayoutProperty(BUILDINGS_LAYER_ID, 'visibility', this.visibility.buildings ? 'visible' : 'none');
      this.map.setLayoutProperty(HEAT_LAYER_ID, 'visibility', this.visibility.heat ? 'visible' : 'none');
      this.map.setLayoutProperty(LIGHT_LAYER_ID, 'visibility', this.visibility.lights ? 'visible' : 'none');
      this.updateHeatOpacity();
    }
    this.render();
  }

  setRoutes(display: RouteDisplay | null): void {
    const prevSelected = this.routeDisplay?.selectedId;
    this.routeDisplay = display;
    const selected = display?.routes.find((r) => r.id === display.selectedId);
    if (!selected) {
      this.trip = null;
      this.stopTrip();
    } else if (selected.id !== prevSelected) {
      this.trip = toTrip(selected.geometry);
      this.playTrip();
    }
    this.render();
  }

  setMarker(kind: 'origin' | 'destination', position: LngLat | null): void {
    this.markers[kind]?.remove();
    this.markers[kind] = undefined;
    if (!position) return;
    const el = document.createElement('div');
    el.className = `marker marker--${kind}`;
    el.innerHTML = '<span class="marker__pulse"></span><span class="marker__dot"></span>';
    this.markers[kind] = new maplibregl.Marker({ element: el }).setLngLat(position).addTo(this.map);
  }

  fitRoute(route: ScoredRoute, paddingLeft: number): void {
    const [sw, ne] = boundsOf(route.geometry);
    this.map.fitBounds([sw, ne], {
      padding: { top: 90, bottom: 90, left: paddingLeft + 60, right: 90 },
      pitch: 45,
      duration: 1200,
    });
  }

  onClick(cb: (p: LngLat) => void): void {
    this.map.on('click', (e) => cb([e.lngLat.lng, e.lngLat.lat]));
  }

  // ---------- câmera ----------

  toggle3D(): boolean {
    const flat = this.map.getPitch() > 5;
    this.map.easeTo({ pitch: flat ? 0 : 55, bearing: flat ? 0 : -18, duration: 900 });
    return !flat;
  }

  resetView(): void {
    this.map.flyTo({ ...CONFIG.initialView, duration: 1600 });
  }

  toggleOrbit(): boolean {
    if (this.orbitFrame) {
      this.stopOrbit();
      return false;
    }
    if (this.map.getPitch() < 30) this.map.easeTo({ pitch: 55, duration: 600 });
    const spin = () => {
      this.map.setBearing(this.map.getBearing() + 0.08);
      this.orbitFrame = requestAnimationFrame(spin);
    };
    this.orbitFrame = requestAnimationFrame(spin);
    return true;
  }

  private stopOrbit(): void {
    if (!this.orbitFrame) return;
    cancelAnimationFrame(this.orbitFrame);
    this.orbitFrame = 0;
    document.dispatchEvent(new CustomEvent('orbit-stopped'));
  }

  // ---------- desempenho ----------

  /** Modo leve: menos resolução, horizonte mais grosseiro, menos inclinação e sem prédios. */
  setLiteMode(on: boolean): void {
    this.lite = on;
    const p = CONFIG.performance;
    const ratio = on ? 1 : Math.min(window.devicePixelRatio || 1, p.pixelRatioCap);
    (this.map as unknown as { setPixelRatio?: (r: number) => void }).setPixelRatio?.(ratio);
    this.map.setMaxPitch(on ? p.maxPitchLite : p.maxPitch);
    this.applyTileLod();
  }

  get liteMode(): boolean {
    return this.lite;
  }

  /**
   * Em vistas inclinadas, tiles distantes são carregados em zoom menor. Como os prédios
   * só existem a partir do zoom 14, eles somem naturalmente no horizonte e o 3D fica
   * concentrado no centro da tela. (API do MapLibre 5; ignorada se não existir.)
   */
  private applyTileLod(): void {
    const [levels, ratio] = CONFIG.performance.tileLod[this.lite ? 'lite' : 'normal'];
    const m = this.map as unknown as { setSourceTileLodParams?: (levels: number, ratio: number) => void };
    try {
      m.setSourceTileLodParams?.(levels, ratio);
    } catch {
      /* versão sem suporte */
    }
  }

  /** Névoa que funde o horizonte com o fundo escuro: foco visual no centro e transição de detalhe escondida. */
  private addHorizonFog(): void {
    const m = this.map as unknown as { setSky?: (sky: Record<string, unknown>) => void };
    try {
      m.setSky?.({
        'sky-color': '#090b10',
        'horizon-color': '#11151d',
        'fog-color': '#090b10',
        'sky-horizon-blend': 0.6,
        'horizon-fog-blend': 0.7,
        'fog-ground-blend': 0.35,
        'atmosphere-blend': 0,
      });
    } catch {
      /* versão sem suporte a céu/névoa */
    }
  }

  /**
   * Mede os quadros por segundo enquanto o mapa se move. Se ficar abaixo do limite em
   * dois movimentos seguidos, avisa (evento "map-slow") para o app ligar o modo leve.
   */
  private watchFrameRate(): void {
    let frames = 0;
    let start = 0;
    let slowStreak = 0;
    // Ignora a animação de abertura, quando os tiles ainda estão carregando.
    const readyAt = performance.now() + 5000;
    const onRender = () => frames++;
    this.map.on('movestart', () => {
      if (this.lite || performance.now() < readyAt) return;
      frames = 0;
      start = performance.now();
      this.map.on('render', onRender);
    });
    this.map.on('moveend', () => {
      this.map.off('render', onRender);
      if (this.lite || !start || this.orbitFrame) return;
      const secs = (performance.now() - start) / 1000;
      start = 0;
      if (secs < 0.8) return; // movimento curto demais para medir
      const fps = frames / secs;
      slowStreak = fps < CONFIG.performance.autoLiteFps ? slowStreak + 1 : 0;
      if (slowStreak >= 2) {
        slowStreak = 0;
        document.dispatchEvent(new CustomEvent('map-slow', { detail: { fps: Math.round(fps) } }));
      }
    });
  }

  // ---------- estilo base ----------

  /** Nomes de bairros e ruas mais claros e com contorno escuro, legíveis sobre o calor. */
  private styleLabels(): void {
    for (const layer of this.map.getStyle().layers) {
      if (layer.type !== 'symbol' || !layer.layout?.['text-field']) continue;
      const isRoad = /road|street|highway|transportation|path/i.test(layer.id);
      const isPlace = /place|neighbourhood|suburb|city|town|village/i.test(layer.id);
      try {
        this.map.setPaintProperty(layer.id, 'text-color', isRoad ? '#c4cad6' : isPlace ? '#f2f4f8' : '#dde2ea');
        this.map.setPaintProperty(layer.id, 'text-halo-color', 'rgba(7, 9, 13, 0.92)');
        this.map.setPaintProperty(layer.id, 'text-halo-width', isPlace ? 2 : 1.6);
        this.map.setPaintProperty(layer.id, 'text-halo-blur', 0.4);
      } catch {
        /* camada sem suporte a essas propriedades */
      }
    }
  }

  private addBuildings(): void {
    const style = this.map.getStyle() as StyleSpecification;
    const sourceId = Object.entries(style.sources).find(([, s]) => s.type === 'vector')?.[0];
    if (!sourceId) return;
    for (const l of style.layers) if (l.type === 'fill-extrusion') this.map.removeLayer(l.id);

    this.map.addLayer(
      {
        id: BUILDINGS_LAYER_ID,
        type: 'fill-extrusion',
        source: sourceId,
        'source-layer': 'building',
        // Prédios só a partir do zoom 14: abaixo disso são milhares de polígonos quase invisíveis.
        minzoom: 14,
        paint: {
          'fill-extrusion-color': [
            'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0],
            0, '#1b1f2a',
            40, '#232a3a',
            120, '#2d3650',
          ],
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['coalesce', ['get', 'render_height'], 6]],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.35, 15, 0.8],
        },
      },
      this.firstLabelLayer,
    );
  }

  /**
   * Calor como camada nativa do MapLibre: roda na GPU, fica abaixo dos rótulos e
   * o raio cresce com o zoom, o que mantém as manchas suaves em qualquer escala.
   */
  private addHeat(): void {
    this.map.addSource(HEAT_SOURCE_ID, { type: 'geojson', data: this.heatData });
    const c = CONFIG.heatColors.map(([r, g, b]) => `rgb(${r},${g},${b})`);
    this.map.addLayer(
      {
        id: HEAT_LAYER_ID,
        type: 'heatmap',
        source: HEAT_SOURCE_ID,
        layout: { visibility: this.visibility.heat ? 'visible' : 'none' },
        paint: {
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'w'], 0, 0, this.heatMax, 1],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 9, 0.55, 12, 0.9, 15, 1.6],
          'heatmap-radius': ['interpolate', ['exponential', 1.6], ['zoom'], 9, 9, 11, 18, 13, 34, 15, 70, 17, 140],
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(255,241,118,0)',
            0.08, 'rgba(255,241,118,0.18)',
            0.22, 'rgba(255,224,102,0.45)',
            0.4, c[1],
            0.58, c[2],
            0.74, c[3],
            0.88, c[4],
            1, c[5],
          ],
          'heatmap-opacity': this.heatOpacityExpr(),
        },
      },
      // Abaixo dos prédios e dos rótulos.
      this.map.getLayer(BUILDINGS_LAYER_ID) ? BUILDINGS_LAYER_ID : this.firstLabelLayer,
    );
  }

  /** Pontos de luz como brilho azulado discreto (camada nativa, GPU). */
  private addLights(): void {
    this.map.addSource(LIGHT_SOURCE_ID, { type: 'geojson', data: this.lightData });
    this.map.addLayer(
      {
        id: LIGHT_LAYER_ID,
        type: 'circle',
        source: LIGHT_SOURCE_ID,
        layout: { visibility: this.visibility.lights ? 'visible' : 'none' },
        paint: {
          'circle-color': '#bfe3ff',
          'circle-radius': ['interpolate', ['exponential', 1.7], ['zoom'], 10, 0.7, 13, 2, 15, 5, 17, 12],
          'circle-blur': 0.8,
          'circle-opacity': [
            'interpolate', ['linear'], ['zoom'],
            10, ['min', 0.5, ['*', 0.08, ['get', 'n']]],
            15, ['min', 0.85, ['*', 0.2, ['get', 'n']]],
          ],
        },
      },
      this.firstLabelLayer,
    );
  }

  private heatOpacityExpr(): ExpressionSpecification {
    const k = this.visibility.columns ? 0.6 : 1;
    // Mais transparente de perto, para as ruas aparecerem por baixo.
    return ['interpolate', ['linear'], ['zoom'], 10, 0.85 * k, 14, 0.65 * k, 17, 0.45 * k];
  }

  private updateHeatOpacity(): void {
    if (this.map.getLayer(HEAT_LAYER_ID)) this.map.setPaintProperty(HEAT_LAYER_ID, 'heatmap-opacity', this.heatOpacityExpr());
  }

  private buildHeatData(): void {
    const cells = new Map<string, { x: number; y: number; w: number }>();
    for (const p of this.crimes) {
      const key = `${Math.floor(p.position[0] / HEAT_CELL_DEG)}:${Math.floor(p.position[1] / HEAT_CELL_DEG)}`;
      const c = cells.get(key);
      // Centroide ponderado: a mancha fica onde as ocorrências realmente estão.
      if (c) {
        c.x += p.position[0] * p.count;
        c.y += p.position[1] * p.count;
        c.w += p.count;
      } else {
        cells.set(key, { x: p.position[0] * p.count, y: p.position[1] * p.count, w: p.count });
      }
    }
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    const weights: number[] = [];
    for (const c of cells.values()) {
      if (c.w <= 0) continue;
      features.push({
        type: 'Feature',
        properties: { w: Math.round(c.w * 10) / 10 },
        geometry: { type: 'Point', coordinates: [c.x / c.w, c.y / c.w] },
      });
      weights.push(c.w);
    }
    weights.sort((a, b) => a - b);
    // Percentil 97 como teto: poucos pontos extremos não "apagam" o resto da cidade.
    this.heatMax = Math.max(1, weights[Math.floor(weights.length * 0.97)] ?? 1);
    this.heatData = { type: 'FeatureCollection', features };
  }

  private updateHeat(): void {
    if (!this.styleReady) return;
    (this.map.getSource(HEAT_SOURCE_ID) as GeoJSONSource | undefined)?.setData(this.heatData);
    this.map.setPaintProperty(HEAT_LAYER_ID, 'heatmap-weight', ['interpolate', ['linear'], ['get', 'w'], 0, 0, this.heatMax, 1]);
  }

  // ---------- camadas deck.gl (colunas, acidentes, rotas) ----------

  private render(): void {
    if (!this.styleReady) return;
    const v = this.visibility;
    const layers: Layer[] = [];
    // Desenha abaixo dos rótulos do mapa. O MapboxOverlay lê `beforeId` dos props da camada,
    // mas o deck.gl 9 não declara a propriedade nos tipos; o spread evita o erro de excesso.
    const belowLabels = { beforeId: this.firstLabelLayer } as object;

    if (v.columns && this.crimes.length) {
      layers.push(
        new HexagonLayer<MapPoint>({
          id: 'crime-columns',
          data: this.crimes,
          ...belowLabels,
          getPosition: (d) => d.position,
          getColorWeight: (d) => d.count,
          colorAggregation: 'SUM',
          getElevationWeight: (d) => d.count,
          elevationAggregation: 'SUM',
          radius: 260,
          coverage: 0.82,
          extruded: true,
          elevationScale: 6 * this.columnsScale,
          elevationRange: [0, 400],
          upperPercentile: 99.5,
          colorRange: CONFIG.heatColors,
          opacity: 0.85,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 90],
          material: { ambient: 0.55, diffuse: 0.6, shininess: 40, specularColor: [60, 64, 70] },
          transitions: { elevationScale: { duration: 1400 } },
          updateTriggers: { getColorWeight: this.crimes, getElevationWeight: this.crimes },
        }),
      );
    }

    if (v.accidents && this.accidents.length) {
      layers.push(
        new ScatterplotLayer<AccidentPoint>({
          id: 'accidents',
          data: this.accidents,
          ...belowLabels,
          getPosition: (d) => d.position,
          getRadius: (d) => 18 + Math.sqrt(d.total) * 10,
          radiusUnits: 'meters',
          radiusMinPixels: 1.5,
          getFillColor: (d) => (d.fatal > 0 ? [...CONFIG.colors.accident, 230] : [...CONFIG.colors.accident, 120]),
          stroked: true,
          getLineColor: (d) => (d.fatal > 0 ? [255, 255, 255, 200] : [0, 0, 0, 0]),
          lineWidthMinPixels: 1,
          pickable: true,
        }),
      );
    }

    if (this.inspect) {
      layers.push(
        new ScatterplotLayer<{ center: LngLat; radiusM: number }>({
          id: 'inspect-area',
          data: [this.inspect],
          getPosition: (d) => d.center,
          getRadius: (d) => d.radiusM,
          radiusUnits: 'meters',
          filled: true,
          getFillColor: [255, 255, 255, 18],
          stroked: true,
          getLineColor: [255, 255, 255, 200],
          lineWidthMinPixels: 1.5,
        }),
      );
    }

    if (this.avoided.length && this.routeDisplay) {
      layers.push(
        new PathLayer<AvoidedSegment>({
          id: 'avoided-glow',
          data: this.avoided,
          getPath: (s) => s.path,
          getColor: [...CONFIG.colors.critical, 70],
          getWidth: 16,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
        }),
        new PathLayer<AvoidedSegment>({
          id: 'avoided',
          data: this.avoided,
          getPath: (s) => s.path,
          getColor: [...CONFIG.colors.critical, 220],
          getWidth: 4,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          pickable: true,
        }),
      );
    }

    const rd = this.routeDisplay;
    if (rd) {
      const selected = rd.routes.find((r) => r.id === rd.selectedId);
      const others = rd.routes.filter((r) => r.id !== rd.selectedId);
      const colorOf = (r: ScoredRoute) =>
        r.id === rd.safestId ? CONFIG.colors.safe : r.id === rd.fastestId ? CONFIG.colors.fastest : CONFIG.colors.alternative;

      layers.push(
        new PathLayer<ScoredRoute>({
          id: 'routes-others',
          data: others,
          getPath: (r) => r.geometry,
          getColor: (r) => [...colorOf(r), 140],
          getWidth: 5,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          pickable: true,
        }),
      );
      if (selected) {
        const c = colorOf(selected);
        layers.push(
          new PathLayer<ScoredRoute>({
            id: 'route-glow',
            data: [selected],
            getPath: (r) => r.geometry,
            getColor: [...c, 60],
            getWidth: 18,
            widthUnits: 'pixels',
            capRounded: true,
            jointRounded: true,
          }),
          new PathLayer<ScoredRoute>({
            id: 'route-core',
            data: [selected],
            getPath: (r) => r.geometry,
            getColor: [...c, 255],
            getWidth: 6,
            widthUnits: 'pixels',
            capRounded: true,
            jointRounded: true,
            pickable: true,
          }),
          new ScatterplotLayer<LngLat>({
            id: 'route-critical',
            data: selected.criticalPoints,
            getPosition: (d) => d,
            getRadius: 4,
            radiusUnits: 'pixels',
            getFillColor: [...CONFIG.colors.critical, 230],
            stroked: true,
            getLineColor: [20, 20, 24, 255],
            lineWidthMinPixels: 1.5,
          }),
        );
        if (this.trip && this.animFrame) {
          layers.push(
            new TripsLayer<Trip>({
              id: 'route-trip',
              data: [this.trip],
              getPath: (d) => d.path,
              getTimestamps: (d) => d.timestamps,
              getColor: [255, 255, 255],
              widthMinPixels: 4,
              capRounded: true,
              jointRounded: true,
              fadeTrail: true,
              trailLength: TRIP_TRAIL,
              currentTime: this.tripTime,
            }),
          );
        }
      }
    }

    this.overlay.setProps({ layers });
  }

  /** Percorre a rota uma única vez e para. */
  private playTrip(): void {
    this.stopTrip();
    if (!this.trip || reducedMotion()) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) / TRIP_DURATION_MS;
      if (t >= 1) {
        this.stopTrip();
        this.render();
        return;
      }
      this.tripTime = t * (TRIP_LOOP + TRIP_TRAIL);
      this.render();
      this.animFrame = requestAnimationFrame(tick);
    };
    this.animFrame = requestAnimationFrame(tick);
  }

  private stopTrip(): void {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    this.animFrame = 0;
  }

  private tooltip(info: PickingInfo): { html: string; className: string } | null {
    if (!info.object || !info.layer) return null;
    const id = info.layer.id;
    if (id === 'crime-columns') {
      const o = info.object as { colorValue?: number };
      const n = Math.round(o.colorValue ?? 0);
      return tip(`<strong>${n.toLocaleString('pt-BR')}</strong> ocorrência${n === 1 ? '' : 's'}<br><span>área de ~520 m</span>`);
    }
    if (id === 'accidents') {
      const a = info.object as AccidentPoint;
      return tip(
        `<strong>${a.total}</strong> acidente${a.total === 1 ? '' : 's'}${a.fatal ? `<br><span class="tip-danger">${a.fatal} com vítima fatal</span>` : ''}`,
      );
    }
    if (id === 'avoided') {
      const s = info.object as AvoidedSegment;
      const x = s.intensity >= 10 ? Math.round(s.intensity) : s.intensity.toFixed(1).replace('.', ',');
      return tip(`<strong>Trecho evitado</strong><br><span>${Math.round(s.lengthM)} m · até ${x}× a média da cidade</span>`);
    }
    if (id === 'route-core' || id === 'routes-others') {
      const r = info.object as ScoredRoute;
      return tip(`<strong>Índice de risco ${r.riskIndex}</strong><br><span>${(r.distanceM / 1000).toFixed(1)} km · ${Math.round(r.durationS / 60)} min</span>`);
    }
    return null;
  }
}

function tip(html: string) {
  return { html, className: 'deck-tip' };
}

function toTrip(path: LngLat[]): Trip {
  const total = lineLength(path) || 1;
  let acc = 0;
  const timestamps = path.map((p, i) => {
    if (i > 0) acc += haversine(path[i - 1], p);
    return (acc / total) * TRIP_LOOP;
  });
  return { path, timestamps };
}
