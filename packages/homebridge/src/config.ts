import { ArtCategory } from 'swiftframe-core';

export const PLUGIN_NAME = 'homebridge-swiftframe';
export const PLATFORM_NAME = 'SwiftFrame';

export type InputType = 'app' | 'key' | 'artmode' | 'artwork';

export interface InputConfig {
  name: string;
  type: InputType;
  /** App id, key name (or comma-separated keys), or artwork content id. Not used for `artmode`. */
  value?: string;
}

export interface TvConfig {
  name: string;
  ip: string;
  mac?: string;
  /**
   * What the TV tile's power button means.
   * `art`: off puts the TV in Art Mode, on returns to TV.
   * `power`: off turns the screen fully off, on wakes it.
   */
  tileMode: 'art' | 'power';
  artModeSwitch: boolean;
  brightnessLight: boolean;
  nextArtworkSwitch: boolean;
  nextArtworkCollection: 'favorites' | 'photos' | 'all';
  slideshowSwitch: boolean;
  slideshowMinutes: number;
  slideshowShuffle: boolean;
  /** Seconds between state checks. */
  pollInterval: number;
  inputs: InputConfig[];
}

const INPUT_TYPES: InputType[] = ['app', 'key', 'artmode', 'artwork'];

/** Fill in defaults and drop entries that cannot work, explaining each one that is dropped. */
export function normalizeTvConfigs(raw: unknown, warn: (message: string) => void): TvConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set<string>();
  const tvs: TvConfig[] = [];

  for (const [index, entry] of raw.entries()) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const ip = typeof item.ip === 'string' ? item.ip.trim() : '';

    if (!ip) {
      warn(`TV #${index + 1} has no IP address and was skipped.`);
      continue;
    }

    if (seen.has(ip)) {
      warn(`TV #${index + 1} repeats the IP address ${ip} and was skipped.`);
      continue;
    }

    seen.add(ip);

    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `Frame TV ${index + 1}`;
    const inputs: InputConfig[] = [];

    for (const input of Array.isArray(item.inputs) ? item.inputs : []) {
      const candidate = (input ?? {}) as Record<string, unknown>;
      const type = candidate.type as InputType;
      const inputName = typeof candidate.name === 'string' ? candidate.name.trim() : '';
      const value = typeof candidate.value === 'string' ? candidate.value.trim() : undefined;

      if (!inputName || !INPUT_TYPES.includes(type)) {
        warn(`${name}: an input without a name or with an unknown type was skipped.`);
        continue;
      }

      if (type !== 'artmode' && !value) {
        warn(`${name}: the input "${inputName}" has no value and was skipped.`);
        continue;
      }

      inputs.push({ name: inputName, type, value });
    }

    const collection = item.nextArtworkCollection;
    const minutes = Number(item.slideshowMinutes);
    const poll = Number(item.pollInterval);

    tvs.push({
      name,
      ip,
      mac: typeof item.mac === 'string' && item.mac.trim() ? item.mac.trim() : undefined,
      tileMode: item.tileMode === 'power' ? 'power' : 'art',
      artModeSwitch: item.artModeSwitch !== false,
      brightnessLight: item.brightnessLight !== false,
      nextArtworkSwitch: item.nextArtworkSwitch === true,
      nextArtworkCollection: collection === 'photos' || collection === 'all' ? collection : 'favorites',
      slideshowSwitch: item.slideshowSwitch === true,
      slideshowMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 30,
      slideshowShuffle: item.slideshowShuffle !== false,
      pollInterval: Number.isFinite(poll) && poll >= 5 ? poll : 15,
      inputs,
    });
  }

  return tvs;
}

export function collectionId(collection: TvConfig['nextArtworkCollection']): string | undefined {
  if (collection === 'favorites') {
    return ArtCategory.FAVORITES;
  }

  if (collection === 'photos') {
    return ArtCategory.MY_PHOTOS;
  }

  return undefined;
}
