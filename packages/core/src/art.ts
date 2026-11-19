import { randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TvChannel, type ChannelMessage, type ChannelOptions } from './channel.js';
import { receiveFiles, sendFile, type D2dConnInfo, type D2dFile } from './d2d.js';
import { ArtRequestError, ArtServiceUnavailableError, InvalidArgumentError, RequestTimeoutError } from './errors.js';
import {
  ArtCategory,
  silentLogger,
  type ArtSetting,
  type Artwork,
  type Logger,
  type MatteList,
  type SlideshowOptions,
  type SlideshowStatus,
  type UploadOptions,
} from './types.js';
import { artApiMajor, clamp, parseMaybeJson } from './util.js';

export type ArtChannelOptions = Omit<ChannelOptions, 'endpoint' | 'readyEvent'> & {
  /** How long to wait for an ordinary reply. */
  responseTimeoutMs?: number;
};

type ArtReply = Record<string, any>;

interface Pending {
  resolve: (reply: ArtReply) => void;
  reject: (error: Error) => void;
}

/**
 * The art service can stop answering while its socket stays open (seen on 2022 Frames after
 * watching TV). After this many timeouts in a row the connection is dropped and requests fail
 * fast for a cooldown that doubles each time the TV still does not answer.
 */
const FAILURE_THRESHOLD = 3;
const COOLDOWN_START_MS = 30_000;
const COOLDOWN_MAX_MS = 240_000;

/**
 * Art Mode and artwork management over the TV's `com.samsung.art-app` channel.
 *
 * Emits `artMode` (boolean), `standby`, `wakeup`, and `event` (name, payload) for everything the TV pushes.
 */
export class ArtClient extends EventEmitter {
  public readonly channel: TvChannel;

  private readonly log: Logger;
  private readonly responseTimeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private readonly uploadWaiters: Pending[] = [];
  private apiVersion: string | undefined;
  private slideshowName: 'slideshow' | 'auto_rotation' | undefined;
  private timeouts = 0;
  private cooldownMs = 0;
  private unavailableUntil = 0;

  constructor(options: ArtChannelOptions) {
    super();
    this.log = options.logger ?? silentLogger;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 5_000;
    this.channel = new TvChannel({ ...options, endpoint: 'com.samsung.art-app', readyEvent: 'ms.channel.ready' });
    this.channel.on('message', (message: ChannelMessage) => this.handleMessage(message));
    this.channel.on('close', () => this.failPending(new RequestTimeoutError('The art channel closed before the TV answered')));
  }

  /** False while requests are failing fast because the art service stopped answering. */
  public get available(): boolean {
    return Date.now() >= this.unavailableUntil;
  }

  /** Forget past timeouts, e.g. when the TV has just been turned on. */
  public resetAvailability(): void {
    this.timeouts = 0;
    this.cooldownMs = 0;
    this.unavailableUntil = 0;
  }

  public close(): void {
    this.channel.close();
  }

  // --- Art Mode -----------------------------------------------------------------------------

  public async getArtMode(): Promise<boolean> {
    const reply = await this.request({ request: 'get_artmode_status' });
    return (reply.value ?? reply.status) === 'on';
  }

  public async setArtMode(on: boolean): Promise<void> {
    await this.request({ request: 'set_artmode_status', value: on ? 'on' : 'off' });
  }

  public async getApiVersion(): Promise<string> {
    if (this.apiVersion) {
      return this.apiVersion;
    }

    let reply: ArtReply | undefined;

    try {
      // Newer TVs answer this; older ones reply quickly with an error.
      reply = await this.request({ request: 'api_version' });
    } catch (error) {
      if (!(error instanceof ArtRequestError)) {
        throw error;
      }
    }

    reply ??= await this.request({ request: 'get_api_version' });

    this.apiVersion = String(reply.version);
    return this.apiVersion;
  }

  // --- Artwork library ----------------------------------------------------------------------

  /** List artwork on the TV, optionally only one collection (see {@link ArtCategory}). */
  public async list(categoryId?: string): Promise<Artwork[]> {
    const reply = await this.request({ request: 'get_content_list', category: categoryId ?? null }, { timeoutMs: 10_000 });
    const items = parseMaybeJson<Artwork[]>(reply.content_list) ?? [];

    return categoryId ? items.filter((item) => item.category_id === categoryId) : items;
  }

  public async getCurrent(): Promise<Artwork> {
    const reply = await this.request({ request: 'get_current_artwork' });
    return reply as Artwork;
  }

  /** Show a piece of art. With `show: false` it is selected but not displayed until Art Mode is next on. */
  public async select(contentId: string, options: { show?: boolean; categoryId?: string } = {}): Promise<void> {
    await this.request({
      request: 'select_image',
      category_id: options.categoryId ?? null,
      content_id: contentId,
      show: options.show ?? true,
    });
  }

  public async setFavorite(contentId: string, favorite: boolean): Promise<void> {
    await this.request(
      { request: 'change_favorite', content_id: contentId, status: favorite ? 'on' : 'off' },
      { waitForEvent: 'favorite_changed' },
    );
  }

  /** Delete uploaded artwork. Art Store pieces cannot be deleted. */
  public async delete(contentIds: string[]): Promise<void> {
    if (contentIds.length === 0) {
      return;
    }

    await this.request({
      request: 'delete_image_list',
      content_id_list: contentIds.map((content_id) => ({ content_id })),
    });
  }

  /**
   * Upload an image and return the content id the TV gave it.
   * Returns null if the TV accepted the bytes but did not confirm in time; the image may still appear.
   */
  public async upload(image: Buffer, options: UploadOptions = {}): Promise<string | null> {
    if (image.length === 0) {
      throw new InvalidArgumentError('The image is empty');
    }

    const fileType = normalizeFileType(options.fileType ?? detectImageType(image));
    const id = randomUUID();

    const reply = await this.request({
      request: 'send_image',
      file_type: fileType,
      id,
      request_id: id,
      conn_info: { d2d_mode: 'socket', connection_id: randomInt(2 ** 32), id },
      image_date: formatImageDate(new Date()),
      matte_id: options.matte ?? 'none',
      portrait_matte_id: options.portraitMatte ?? 'none',
      file_size: image.length,
    });

    const connInfo = parseMaybeJson<D2dConnInfo>(reply.conn_info);

    if (!connInfo) {
      throw new ArtRequestError('send_image', 'no transfer socket offered');
    }

    const added = new Promise<ArtReply>((resolve, reject) => {
      this.uploadWaiters.push({ resolve, reject });
    });

    // Avoid an unhandled rejection if the channel closes after we stop waiting.
    added.catch(() => {});

    await sendFile(connInfo, image, fileType);

    const timeoutMs = options.timeoutMs ?? 30_000;
    let timer: NodeJS.Timeout;

    const result = await Promise.race([
      added.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));

    if (!result) {
      this.log.warn('The TV did not confirm the upload in time; the image may still be added');
      return null;
    }

    return String(result.content_id);
  }

  /** Fetch thumbnails for one or more pieces of art. */
  public async getThumbnails(contentIds: string[]): Promise<D2dFile[]> {
    if (contentIds.length === 0) {
      return [];
    }

    const major = artApiMajor(await this.getApiVersion().catch(() => undefined));
    const connInfo = { d2d_mode: 'socket', connection_id: randomInt(2 ** 32), id: randomUUID() };

    // Art API 4 (2022 Frames) replaced get_thumbnail with get_thumbnail_list.
    if (major >= 4) {
      const reply = await this.request({
        request: 'get_thumbnail_list',
        content_id_list: contentIds.map((content_id) => ({ content_id })),
        conn_info: connInfo,
      });

      return receiveFiles(requireConnInfo(reply, 'get_thumbnail_list'));
    }

    const files: D2dFile[] = [];

    for (const content_id of contentIds) {
      const reply = await this.request({
        request: 'get_thumbnail',
        content_id,
        conn_info: { ...connInfo, connection_id: randomInt(2 ** 32), id: randomUUID() },
      });

      files.push(...(await receiveFiles({ ...requireConnInfo(reply, 'get_thumbnail'), secured: false })));
    }

    return files;
  }

  // --- Mattes and filters -------------------------------------------------------------------

  public async getMatteList(): Promise<MatteList> {
    const reply = await this.request({ request: 'get_matte_list' });
    const types = parseMaybeJson<Array<{ matte_type: string }>>(reply.matte_type_list) ?? [];
    const colors = parseMaybeJson<Array<{ color: string }>>(reply.matte_color_list) ?? [];

    return { types: types.map((item) => item.matte_type), colors: colors.map((item) => item.color) };
  }

  /** Change the matte, e.g. `shadowbox_polar`, or `none`. Not every matte suits every image size. */
  public async changeMatte(contentId: string, matteId: string, portraitMatteId?: string): Promise<void> {
    await this.request({
      request: 'change_matte',
      content_id: contentId,
      matte_id: matteId || 'none',
      ...(portraitMatteId ? { portrait_matte_id: portraitMatteId } : {}),
    });
  }

  public async getPhotoFilterList(): Promise<Array<{ filter_id: string; filter_name?: string }>> {
    const reply = await this.request({ request: 'get_photo_filter_list' });
    return parseMaybeJson(reply.filter_list) ?? [];
  }

  public async setPhotoFilter(contentId: string, filterId: string): Promise<void> {
    await this.request({ request: 'set_photo_filter', content_id: contentId, filter_id: filterId });
  }

  // --- Art Mode settings --------------------------------------------------------------------

  public async getSettings(): Promise<ArtSetting[]> {
    const major = artApiMajor(await this.getApiVersion().catch(() => undefined));

    if (major >= 4) {
      try {
        const reply = await this.request({ request: 'get_artmode_settings' });
        const settings = parseMaybeJson<ArtSetting[]>(reply.data);

        if (settings) {
          return settings;
        }
      } catch (error) {
        if (!(error instanceof ArtRequestError)) {
          throw error;
        }
      }
    }

    // Older art APIs have one request per setting.
    const settings: ArtSetting[] = [];

    for (const item of ['brightness', 'color_temperature']) {
      try {
        const reply = await this.request({ request: `get_${item}` });
        settings.push({ item, value: String(reply.value ?? reply.status), min: reply.min, max: reply.max });
      } catch (error) {
        if (!(error instanceof ArtRequestError)) {
          throw error;
        }
      }
    }

    return settings;
  }

  /** Art Mode brightness, 0 to 10. */
  public async getBrightness(): Promise<number> {
    const setting = (await this.getSettings()).find((item) => item.item === 'brightness');

    if (!setting) {
      throw new ArtRequestError('get_brightness', 'not reported');
    }

    return Number(setting.value);
  }

  public async setBrightness(value: number): Promise<void> {
    await this.request({ request: 'set_brightness', value: clamp(Math.round(value), 0, 10) });
  }

  /** Art Mode colour tone, -5 (cooler) to 5 (warmer). */
  public async setColorTemperature(value: number): Promise<void> {
    await this.request({ request: 'set_color_temperature', value: clamp(Math.round(value), -5, 5) });
  }

  // --- Slideshow ----------------------------------------------------------------------------

  public async getSlideshow(): Promise<SlideshowStatus> {
    return (await this.slideshowRequest('get')) as SlideshowStatus;
  }

  public async setSlideshow(options: SlideshowOptions): Promise<void> {
    await this.slideshowRequest('set', {
      value: options.minutes > 0 ? String(Math.round(options.minutes)) : 'off',
      category_id: options.categoryId ?? ArtCategory.MY_PHOTOS,
      type: (options.shuffle ?? true) ? 'shuffleslideshow' : 'slideshow',
    });
  }

  /**
   * Art API 2 (2021) calls the feature `auto_rotation`; API 4 (2022) renamed it `slideshow`.
   * Each TV rejects or ignores the other name, so try the likely one first and remember what works.
   */
  private async slideshowRequest(action: 'get' | 'set', fields: Record<string, unknown> = {}): Promise<ArtReply> {
    if (!this.slideshowName) {
      const major = artApiMajor(await this.getApiVersion().catch(() => undefined));
      this.slideshowName = major < 4 ? 'auto_rotation' : 'slideshow';
    }

    const first = this.slideshowName;
    const second = first === 'slideshow' ? 'auto_rotation' : 'slideshow';
    let lastError: unknown;

    for (const name of [first, second] as const) {
      try {
        const reply = await this.request({ request: `${action}_${name}_status`, ...fields });
        this.slideshowName = name;
        return reply;
      } catch (error) {
        if (error instanceof ArtServiceUnavailableError) {
          throw error;
        }

        lastError = error;
      }
    }

    throw lastError;
  }

  // --- Request plumbing ---------------------------------------------------------------------

  /**
   * Send one art request and wait for the TV's reply.
   * Replies are matched by request id, or by event name for the few requests the TV answers without one.
   */
  public async request(body: Record<string, unknown>, options: { waitForEvent?: string; timeoutMs?: number } = {}): Promise<ArtReply> {
    const remaining = this.unavailableUntil - Date.now();

    if (remaining > 0) {
      throw new ArtServiceUnavailableError(remaining);
    }

    const id = typeof body.id === 'string' ? body.id : randomUUID();
    const key = options.waitForEvent ?? id;
    const name = String(body.request);
    const timeoutMs = options.timeoutMs ?? this.responseTimeoutMs;

    let timer: NodeJS.Timeout | undefined;

    const reply = new Promise<ArtReply>((resolve, reject) => {
      this.pending.set(key, { resolve, reject });

      timer = setTimeout(() => {
        this.pending.delete(key);
        this.recordTimeout(name);
        reject(new RequestTimeoutError(`The TV did not answer the art request "${name}"`));
      }, timeoutMs);
    });

    // The send below may throw first; the reply promise must not become an unhandled rejection.
    reply.catch(() => {});

    try {
      await this.channel.send({
        method: 'ms.channel.emit',
        params: {
          event: 'art_app_request',
          to: 'host',
          // Old art APIs read `id`, new ones `request_id`; both must match.
          data: JSON.stringify({ ...body, id, request_id: id }),
        },
      });

      return await reply;
    } finally {
      clearTimeout(timer);
      this.pending.delete(key);
    }
  }

  private recordTimeout(request: string): void {
    this.timeouts += 1;

    // Once we have backed off, a single further timeout is enough to back off again.
    const threshold = this.cooldownMs ? 1 : FAILURE_THRESHOLD;

    this.log.debug(`[art] "${request}" timed out (${this.timeouts}/${threshold})`);

    if (this.timeouts < threshold) {
      return;
    }

    this.timeouts = 0;
    this.cooldownMs = Math.min(this.cooldownMs * 2 || COOLDOWN_START_MS, COOLDOWN_MAX_MS);
    this.unavailableUntil = Date.now() + this.cooldownMs;
    this.log.warn(`The TV's art service is not answering; reconnecting and pausing art requests for ${this.cooldownMs / 1000}s`);
    this.channel.reset();
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }

    this.pending.clear();

    for (const waiter of this.uploadWaiters.splice(0)) {
      waiter.reject(error);
    }
  }

  private handleMessage(message: ChannelMessage): void {
    if (message.event !== 'd2d_service_message') {
      return;
    }

    const data = parseMaybeJson<ArtReply>(message.data);

    if (!data || typeof data !== 'object') {
      return;
    }

    // Anything from the art service proves it is alive.
    this.timeouts = 0;
    this.cooldownMs = 0;

    const event = String(data.event ?? '');

    if (event.includes('artmode_status')) {
      this.emit('artMode', (data.value ?? data.status) === 'on');
    } else if (event === 'art_mode_changed') {
      this.emit('artMode', data.status === 'on');
    } else if (event === 'go_to_standby') {
      this.emit('standby');
    } else if (event.includes('wakeup')) {
      this.emit('wakeup');
    }

    this.emit('event', event, data);

    const id = (data.request_id ?? data.id) as string | undefined;

    if (event === 'image_added') {
      // 2022 Frames send no id with image_added, so it goes to the oldest upload still waiting.
      const waiter = this.uploadWaiters.shift();

      if (waiter) {
        waiter.resolve(data);
        return;
      }
    }

    const key = id && this.pending.has(id) ? id : this.pending.has(event) ? event : undefined;

    if (!key) {
      return;
    }

    const pending = this.pending.get(key)!;
    this.pending.delete(key);

    if (event === 'error') {
      const original = parseMaybeJson<{ request?: string }>(data.request_data);
      pending.reject(new ArtRequestError(original?.request ?? 'unknown', data.error_code ?? 'unknown'));
    } else {
      pending.resolve(data);
    }
  }
}

function requireConnInfo(reply: ArtReply, request: string): D2dConnInfo {
  const info = parseMaybeJson<D2dConnInfo>(reply.conn_info);

  if (!info) {
    throw new ArtRequestError(request, 'no transfer socket offered');
  }

  return info;
}

function normalizeFileType(type: string): string {
  const lower = type.toLowerCase().replace(/^\./, '');
  return lower === 'jpeg' ? 'jpg' : lower;
}

/** Tell JPEG from PNG by the file's first bytes. */
export function detectImageType(image: Buffer): 'jpg' | 'png' {
  if (image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }

  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
    return 'jpg';
  }

  throw new InvalidArgumentError('Only JPEG and PNG images can be uploaded');
}

/** `YYYY:MM:DD HH:MM:SS`, the EXIF-style date the TV expects. */
function formatImageDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
