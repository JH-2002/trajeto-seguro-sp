import { CONFIG } from '../config';
import type { LngLat, Place } from '../types';

interface PhotonFeature {
  geometry: { coordinates: LngLat };
  properties: {
    name?: string;
    street?: string;
    housenumber?: string;
    district?: string;
    locality?: string;
    city?: string;
    state?: string;
    type?: string;
  };
}

function toPlace(f: PhotonFeature): Place {
  const p = f.properties;
  const street = [p.street, p.housenumber].filter(Boolean).join(', ');
  const label = p.name ?? (street || 'Local sem nome');
  const detail = [p.name && street ? street : null, p.district ?? p.locality, p.city]
    .filter(Boolean)
    .join(' · ');
  return { label, detail, position: f.geometry.coordinates };
}

/** Geocodificador com autocompletar, limitado à área do município. */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const [w, s, e, n] = CONFIG.bbox;
  const params = new URLSearchParams({
    q: query,
    limit: '6',
    bbox: `${w},${s},${e},${n}`,
    lat: String(CONFIG.initialView.center[1]),
    lon: String(CONFIG.initialView.center[0]),
  });
  const res = await fetch(`${CONFIG.photonUrl}/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`Busca de endereços falhou (${res.status}).`);
  const data = (await res.json()) as { features: PhotonFeature[] };
  return data.features.map(toPlace);
}

export async function reversePlace(position: LngLat, signal?: AbortSignal): Promise<Place | null> {
  const params = new URLSearchParams({ lon: String(position[0]), lat: String(position[1]), limit: '1' });
  try {
    const res = await fetch(`${CONFIG.photonUrl}/reverse?${params}`, { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { features: PhotonFeature[] };
    const f = data.features[0];
    return f ? { ...toPlace(f), position } : null;
  } catch {
    return null;
  }
}
