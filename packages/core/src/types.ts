/** Minimal logger so the core has no dependency on Homebridge or any logging library. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Where the pairing token the TV hands out is kept between runs. */
export interface TokenStore {
  get(): string | undefined;
  set(token: string): void;
}

/** What the TV reports about itself on `http://<ip>:8001/api/v2/`. */
export interface DeviceInfo {
  name?: string;
  model?: string;
  modelName?: string;
  firmware?: string;
  wifiMac?: string;
  /** True when the TV says it is a Frame. */
  frameSupport: boolean;
  /** True when the TV uses token pairing (2018 and later). */
  tokenSupport: boolean;
  /** `on` or `standby` when the TV reports it, otherwise undefined. */
  powerState?: string;
  raw: unknown;
}

/**
 * - `on`: the screen is showing TV, an app or an input.
 * - `art`: the screen is showing Art Mode.
 * - `standby`: the screen is off but the TV still answers on the network.
 * - `off`: the TV does not answer at all.
 */
export type PowerStatus = 'on' | 'art' | 'standby' | 'off';

export interface FrameState {
  status: PowerStatus;
  /** Null until the TV has told us, or when the TV is not a Frame. */
  artMode: boolean | null;
  reachable: boolean;
}

export interface Artwork {
  content_id: string;
  category_id?: string;
  matte_id?: string;
  portrait_matte_id?: string;
  width?: number;
  height?: number;
  image_date?: string;
  content_type?: string;
  [key: string]: unknown;
}

export interface ArtSetting {
  item: string;
  value: string;
  min?: string;
  max?: string;
  valid_values?: string[];
  [key: string]: unknown;
}

export interface SlideshowStatus {
  /** Minutes between changes, or `off`. */
  value: string;
  category_id?: string;
  type?: string;
  [key: string]: unknown;
}

export interface SlideshowOptions {
  /** Minutes between changes. 0 turns the slideshow off. */
  minutes: number;
  shuffle?: boolean;
  /** Which collection to rotate through. Defaults to My Photos. */
  categoryId?: string;
}

export interface UploadOptions {
  /** `jpg` or `png`. */
  fileType?: string;
  /** Matte id such as `shadowbox_polar`, or `none`. */
  matte?: string;
  portraitMatte?: string;
  /** How long to wait for the TV to confirm the image, in milliseconds. */
  timeoutMs?: number;
}

export interface MatteList {
  types: string[];
  colors: string[];
}

/** Well-known artwork collections on the TV. */
export const ArtCategory = {
  MY_PHOTOS: 'MY-C0002',
  FAVORITES: 'MY-C0004',
  ART_STORE: 'MY-C0008',
} as const;
