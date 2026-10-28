import type { LngLat, Route, TravelMode } from '../types';

export interface RouteRequestOptions {
  alternatives?: boolean;
  signal?: AbortSignal;
}

/** Contrato para trocar o motor de rotas (OSRM, GraphHopper, Valhalla...). */
export interface RoutingProvider {
  route(waypoints: LngLat[], mode: TravelMode, opts?: RouteRequestOptions): Promise<Route[]>;
}

interface OsrmResponse {
  code: string;
  message?: string;
  routes?: { distance: number; duration: number; geometry: { coordinates: LngLat[] } }[];
}

let routeSeq = 0;

export class OsrmProvider implements RoutingProvider {
  /** Fila simples para não sobrecarregar servidores públicos (máx. 2 em paralelo). */
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly baseUrls: Record<TravelMode, string>,
    private readonly maxConcurrent = 2,
  ) {}

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  async route(waypoints: LngLat[], mode: TravelMode, opts: RouteRequestOptions = {}): Promise<Route[]> {
    const coords = waypoints.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');
    const params = new URLSearchParams({
      overview: 'full',
      geometries: 'geojson',
      steps: 'false',
      alternatives: opts.alternatives && waypoints.length === 2 ? '3' : 'false',
    });
    // O OSRM ignora o nome do perfil na URL; o modo é definido pelo servidor (routed-foot/bike/car).
    const url = `${this.baseUrls[mode]}/route/v1/driving/${coords}?${params}`;

    return this.slot(async () => {
      const res = await fetch(url, { signal: opts.signal });
      if (!res.ok) throw new Error(`Servidor de rotas respondeu ${res.status}.`);
      const data = (await res.json()) as OsrmResponse;
      if (data.code !== 'Ok' || !data.routes) throw new Error(data.message ?? 'Rota não encontrada.');
      return data.routes.map((r) => ({
        id: `r${++routeSeq}`,
        geometry: r.geometry.coordinates,
        distanceM: r.distance,
        durationS: r.duration,
        via: waypoints.length > 2 ? waypoints[1] : undefined,
      }));
    });
  }
}
