import { EventEmitter } from 'node:events';
import { ArtClient } from './art.js';
import { ConnectionError, InvalidArgumentError, NotAFrameError } from './errors.js';
import { RemoteClient } from './remote.js';
import { getDeviceInfo } from './rest.js';
import { MemoryTokenStore } from './token-store.js';
import { silentLogger, type DeviceInfo, type FrameState, type Logger, type PowerStatus, type TokenStore } from './types.js';
import { VolumeClient } from './upnp.js';
import { errorMessage, sleep } from './util.js';
import { wake, type WakeOptions } from './wol.js';

export interface FrameTVOptions {
  /** IP address or hostname of the TV. Give the TV a fixed address on your router. */
  host: string;
  /** MAC address, needed to wake the TV when it is fully off. Discovered automatically once the TV is on. */
  mac?: string;
  /** Name shown on the TV's pairing prompt. */
  clientName?: string;
  tokenStore?: TokenStore;
  logger?: Logger;
  /** How often to check the TV's state while monitoring. */
  pollIntervalMs?: number;
  wake?: WakeOptions;
  /** How long to hold the power key for a full power-off on a Frame. */
  powerOffHoldMs?: number;
  /** Overrides for testing against something other than a real TV. */
  transport?: { restPort?: number; wsPort?: number; upnpPort?: number; secure?: boolean };
}

const INFO_CACHE_MS = 2_000;

/**
 * One Samsung Frame TV on the local network.
 *
 * Combines the TV's separate interfaces (device info, remote keys, the art service, volume, wake-on-LAN)
 * behind one object and tracks a single state: on, art, standby or off.
 *
 * Emits `state` (current, previous) whenever that state changes.
 */
export class FrameTV extends EventEmitter {
  public readonly remote: RemoteClient;
  public readonly art: ArtClient;
  public readonly volume: VolumeClient;

  private readonly log: Logger;
  private readonly tokenStore: TokenStore;
  private currentState: FrameState = { status: 'off', artMode: null, reachable: false };
  private info: DeviceInfo | undefined;
  private infoFetchedAt = 0;
  private mac: string | undefined;
  private pollTimer?: NodeJS.Timeout;
  private refreshing: Promise<FrameState> | null = null;
  private monitoring = false;

  constructor(private readonly options: FrameTVOptions) {
    super();

    if (!options.host) {
      throw new InvalidArgumentError('A TV host or IP address is required');
    }

    this.log = options.logger ?? silentLogger;
    this.tokenStore = options.tokenStore ?? new MemoryTokenStore();
    this.mac = options.mac;

    const channel = {
      host: options.host,
      port: options.transport?.wsPort,
      secure: options.transport?.secure,
      clientName: options.clientName,
      tokenStore: this.tokenStore,
      logger: this.log,
    };

    this.remote = new RemoteClient(channel);
    this.art = new ArtClient(channel);
    this.volume = new VolumeClient(options.host, { port: options.transport?.upnpPort });

    this.art.on('artMode', (on: boolean) => this.applyArtMode(on));
    this.art.on('standby', () => void this.refresh().catch(() => {}));
    this.art.on('wakeup', () => {
      this.art.resetAvailability();
      void this.refresh().catch(() => {});
    });
  }

  public get host(): string {
    return this.options.host;
  }

  public get state(): FrameState {
    return { ...this.currentState };
  }

  public get isPaired(): boolean {
    return !!this.tokenStore.get();
  }

  /** True once the TV has told us it is a Frame. */
  public get isFrame(): boolean {
    return this.info?.frameSupport ?? false;
  }

  // --- Lifecycle ----------------------------------------------------------------------------

  /** Start tracking the TV's state in the background. */
  public async start(): Promise<void> {
    if (this.monitoring) {
      return;
    }

    this.monitoring = true;
    await this.refresh().catch(() => {});

    this.pollTimer = setInterval(() => void this.refresh().catch(() => {}), this.options.pollIntervalMs ?? 15_000);
    this.pollTimer.unref?.();
  }

  public stop(): void {
    this.monitoring = false;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.remote.close();
    this.art.close();
  }

  /**
   * Pair with the TV. The first time, the TV shows an Allow/Deny prompt and this resolves once it is accepted.
   * The TV must be on.
   */
  public async pair(): Promise<void> {
    await this.remote.pair();
    await this.refresh().catch(() => {});
  }

  public async getInfo(options: { fresh?: boolean } = {}): Promise<DeviceInfo> {
    if (!options.fresh && this.info && Date.now() - this.infoFetchedAt < INFO_CACHE_MS) {
      return this.info;
    }

    const info = await getDeviceInfo(this.options.host, { port: this.options.transport?.restPort });

    this.info = info;
    this.infoFetchedAt = Date.now();
    this.mac ??= info.wifiMac;

    return info;
  }

  /** Check the TV now and return its state. Concurrent calls share one check. */
  public refresh(): Promise<FrameState> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });

    return this.refreshing;
  }

  private async doRefresh(): Promise<FrameState> {
    let info: DeviceInfo;

    try {
      info = await this.getInfo({ fresh: true });
    } catch {
      this.art.channel.setKeepAlive(false);
      return this.setState({ status: 'off', artMode: this.currentState.artMode, reachable: false });
    }

    if (info.powerState && info.powerState !== 'on') {
      this.art.channel.setKeepAlive(false);
      return this.setState({ status: 'standby', artMode: info.frameSupport ? false : null, reachable: true });
    }

    let artMode: boolean | null = info.frameSupport ? this.currentState.artMode : null;

    if (info.frameSupport && this.isPaired) {
      // Keep the art channel open so the TV can push Art Mode changes as they happen.
      if (this.monitoring) {
        this.art.channel.setKeepAlive(true);
      }

      if (this.art.available) {
        try {
          artMode = await this.art.getArtMode();
        } catch (error) {
          this.log.debug(`Could not read Art Mode: ${errorMessage(error)}`);
        }
      }
    }

    return this.setState({ status: artMode ? 'art' : 'on', artMode, reachable: true });
  }

  private applyArtMode(on: boolean): void {
    if (!this.currentState.reachable || this.currentState.status === 'standby') {
      // The TV only reports Art Mode while its screen is on, so this also tells us it woke up.
      void this.refresh().catch(() => {});
      return;
    }

    this.setState({ status: on ? 'art' : 'on', artMode: on, reachable: true });
  }

  private setState(next: FrameState): FrameState {
    const previous = this.currentState;
    this.currentState = next;

    if (previous.status !== next.status || previous.artMode !== next.artMode || previous.reachable !== next.reachable) {
      this.log.debug(`State: ${previous.status} -> ${next.status}`);
      this.emit('state', { ...next }, { ...previous });
    }

    return { ...next };
  }

  /** Poll until the TV reaches one of the given states, or give up. */
  private async waitFor(statuses: PowerStatus[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const state = await this.refresh().catch(() => this.currentState);

      if (statuses.includes(state.status)) {
        return true;
      }

      await sleep(1_000);
    }

    return false;
  }

  // --- Power --------------------------------------------------------------------------------

  /** Bring the screen on from standby or fully off. Leaves Art Mode alone if the TV wakes into it. */
  private async wakeScreen(): Promise<void> {
    const state = await this.refresh();

    if (state.status === 'on' || state.status === 'art') {
      return;
    }

    if (state.status === 'standby') {
      await this.remote.sendKey('KEY_POWER');
    } else {
      if (!this.mac) {
        throw new ConnectionError(
          'The TV is not reachable and its MAC address is unknown, so it cannot be woken. Add the MAC address to the configuration.',
        );
      }

      await wake(this.mac, this.options.wake);
    }

    this.art.resetAvailability();

    if (!(await this.waitFor(['on', 'art'], 20_000))) {
      throw new ConnectionError('The TV did not turn on. Check that it is connected to the network and that the MAC address is correct.');
    }
  }

  /** Turn on to regular TV. If the TV is in Art Mode, leaves Art Mode. */
  public async turnOn(): Promise<void> {
    await this.wakeScreen();

    if (this.currentState.status === 'art') {
      await this.setArtMode(false);
    }
  }

  /**
   * Turn the screen fully off.
   *
   * A short press of the power key on a Frame only toggles Art Mode, so a Frame gets a long press.
   * Some newer Frame firmware ignores the long press over the network; in that case this leaves the
   * TV in Art Mode and the returned promise rejects.
   */
  public async turnOff(): Promise<void> {
    const state = await this.refresh();

    if (state.status === 'off' || state.status === 'standby') {
      return;
    }

    if (this.isFrame) {
      await this.remote.holdKey('KEY_POWER', this.options.powerOffHoldMs ?? 3_500);
    } else {
      await this.remote.sendKey('KEY_POWER');
    }

    if (!(await this.waitFor(['standby', 'off'], 12_000))) {
      throw new ConnectionError('The TV did not turn off. Some Frame firmware ignores a network power-off; it may have switched to Art Mode instead.');
    }
  }

  // --- Art Mode -----------------------------------------------------------------------------

  /** Switch Art Mode on or off, waking the TV first if needed. */
  public async setArtMode(on: boolean): Promise<void> {
    await this.requireFrame();
    await this.wakeScreen();
    await this.art.setArtMode(on);
    this.applyArtMode(on);
  }

  public async getArtMode(): Promise<boolean> {
    await this.requireFrame();
    const state = await this.refresh();
    return state.artMode ?? false;
  }

  /** Reject with a clear message if this TV is not a Frame. */
  public async requireFrame(): Promise<void> {
    if (this.info?.frameSupport) {
      return;
    }

    let info: DeviceInfo;

    try {
      info = await this.getInfo();
    } catch (error) {
      // If the TV is off we cannot ask. Let the caller's own request surface the real problem.
      this.log.debug(`Could not confirm Frame support: ${errorMessage(error)}`);
      return;
    }

    if (!info.frameSupport) {
      throw new NotAFrameError();
    }
  }

  // --- Remote -------------------------------------------------------------------------------

  public sendKey(key: string): Promise<void> {
    return this.remote.sendKey(key);
  }

  public sendKeys(keys: string[]): Promise<void> {
    return this.remote.sendKeys(keys);
  }

  public holdKey(key: string, durationMs: number): Promise<void> {
    return this.remote.holdKey(key, durationMs);
  }

  public launchApp(appId: string, options?: { deepLink?: boolean; metaTag?: string }): Promise<void> {
    return this.remote.launchApp(appId, options);
  }
}
