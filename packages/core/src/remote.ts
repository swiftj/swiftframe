import { TvChannel, type ChannelOptions } from './channel.js';
import { sleep } from './util.js';

export type RemoteChannelOptions = Omit<ChannelOptions, 'endpoint' | 'readyEvent'>;

/** Pause between keys in a sequence; the TV drops keys sent faster than this. */
const KEY_GAP_MS = 400;

/**
 * The TV's remote-control channel: key presses and app launching.
 * The first connection makes the TV show an Allow/Deny prompt and hands back the pairing token.
 */
export class RemoteClient {
  public readonly channel: TvChannel;

  constructor(options: RemoteChannelOptions) {
    this.channel = new TvChannel({ ...options, endpoint: 'samsung.remote.control', readyEvent: 'ms.channel.connect' });
  }

  /** Connect, prompting on the TV if this client has not been paired yet. */
  public pair(): Promise<void> {
    return this.channel.connect();
  }

  public sendKey(key: string, action: 'Click' | 'Press' | 'Release' = 'Click'): Promise<void> {
    return this.channel.send({
      method: 'ms.remote.control',
      params: {
        Cmd: action,
        DataOfCmd: normalizeKey(key),
        Option: 'false',
        TypeOfRemote: 'SendRemoteKey',
      },
    });
  }

  /** Send several keys in order, leaving the TV time to act on each. */
  public async sendKeys(keys: string[]): Promise<void> {
    for (const [index, key] of keys.entries()) {
      await this.sendKey(key);

      if (index < keys.length - 1) {
        await sleep(KEY_GAP_MS);
      }
    }
  }

  public async holdKey(key: string, durationMs: number): Promise<void> {
    await this.sendKey(key, 'Press');
    await sleep(durationMs);
    await this.sendKey(key, 'Release');
  }

  /** Launch an installed app by its Tizen app id. */
  public launchApp(appId: string, options: { deepLink?: boolean; metaTag?: string } = {}): Promise<void> {
    return this.channel.send({
      method: 'ms.channel.emit',
      params: {
        event: 'ed.apps.launch',
        to: 'host',
        data: {
          action_type: (options.deepLink ?? true) ? 'DEEP_LINK' : 'NATIVE_LAUNCH',
          appId,
          metaTag: options.metaTag ?? '',
        },
      },
    });
  }

  public close(): void {
    this.channel.close();
  }
}

/** Accept `home`, `Home`, `KEY_HOME`: always send `KEY_HOME`. */
export function normalizeKey(key: string): string {
  const upper = key.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return upper.startsWith('KEY_') ? upper : `KEY_${upper}`;
}
