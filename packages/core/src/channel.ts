import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import { ConnectionError, UnauthorizedError } from './errors.js';
import { silentLogger, type Logger, type TokenStore } from './types.js';
import { errorMessage } from './util.js';

export interface ChannelOptions {
  host: string;
  /** Channel name, e.g. `samsung.remote.control` or `com.samsung.art-app`. */
  endpoint: string;
  tokenStore: TokenStore;
  /** The event that means the channel is usable. The art channel sends `ms.channel.ready` after `ms.channel.connect`. */
  readyEvent: 'ms.channel.connect' | 'ms.channel.ready';
  port?: number;
  /** Use TLS. Token-paired TVs only accept TLS on port 8002. */
  secure?: boolean;
  /** Name shown on the TV's pairing prompt and in its device list. */
  clientName?: string;
  logger?: Logger;
  /** How long to wait for the TV when a token is already saved. */
  connectTimeoutMs?: number;
  /** How long to wait while the TV shows its Allow/Deny prompt. */
  pairingTimeoutMs?: number;
  /** How often to ping the TV to detect a dead connection. */
  pingIntervalMs?: number;
  /** How long to wait for `ms.channel.ready` after `ms.channel.connect` before using the channel anyway. */
  readyFallbackMs?: number;
}

export interface ChannelMessage {
  event?: string;
  data?: unknown;
  [key: string]: unknown;
}

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * One WebSocket channel to the TV.
 *
 * Connects on demand, shares a single in-flight connection attempt between callers, detects
 * connections that have silently died, and (when `keepAlive` is on) reconnects with backoff.
 *
 * Emits `open`, `close`, `ready` (the TV-side app announced itself) and `message` (a parsed {@link ChannelMessage}).
 */
export class TvChannel extends EventEmitter {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private pingTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelay = RECONNECT_MIN_MS;
  private awaitingPong = false;
  private keepAlive = false;
  private closedByUs = false;
  private readonly log: Logger;

  /** The id the TV assigned to this client on the current connection. */
  public clientId: string | undefined;

  /** True once the TV-side app has sent `ms.channel.ready` on the current connection. */
  public ready = false;

  /**
   * How many TV-side hosts were on the channel when we joined, or undefined if the TV did not say.
   * Zero with `ready` false means the app that should answer requests is not running.
   */
  public hostCount: number | undefined;

  constructor(private readonly options: ChannelOptions) {
    super();
    this.log = options.logger ?? silentLogger;
  }

  public get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Keep the channel open and reconnect whenever it drops. Turn off while the TV is known to be off. */
  public setKeepAlive(enabled: boolean): void {
    this.keepAlive = enabled;

    if (!enabled) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      return;
    }

    if (!this.isOpen && !this.connecting && !this.reconnectTimer) {
      this.connect().catch(() => {});
    }
  }

  public connect(): Promise<void> {
    if (this.isOpen) {
      return Promise.resolve();
    }

    this.connecting ??= this.open()
      .catch((error) => {
        this.scheduleReconnect();
        throw error;
      })
      .finally(() => {
        this.connecting = null;
      });

    return this.connecting;
  }

  public async send(payload: unknown): Promise<void> {
    await this.connect();

    const socket = this.socket;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new ConnectionError(`The ${this.options.endpoint} channel closed before the message could be sent`);
    }

    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(payload), (error) => {
        if (error) {
          reject(new ConnectionError(`Failed to send to the TV: ${error.message}`, { cause: error }));
        } else {
          resolve();
        }
      });
    });
  }

  /** Drop the connection. With `keepAlive` on it will be re-established. */
  public reset(): void {
    if (this.socket) {
      this.drop(this.socket);
    }
  }

  /**
   * Treat a socket as closed right now instead of waiting for its close event, so a request
   * made immediately afterwards starts on a fresh connection and is not failed by the old one.
   */
  private drop(socket: WebSocket): void {
    this.handleClose(socket);
    socket.terminate();
  }

  /** Close for good and stop reconnecting. */
  public close(): void {
    this.closedByUs = true;
    this.keepAlive = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopPing();
    this.socket?.terminate();
    this.socket = null;
  }

  private buildUrl(): string {
    const { host, endpoint, tokenStore } = this.options;
    const scheme = (this.options.secure ?? true) ? 'wss' : 'ws';
    const port = this.options.port ?? 8002;
    const name = Buffer.from(this.options.clientName ?? 'SwiftFrame').toString('base64');
    const token = tokenStore.get();
    const query = new URLSearchParams({ name });

    if (token) {
      query.set('token', token);
    }

    return `${scheme}://${host}:${port}/api/v2/channels/${endpoint}?${query}`;
  }

  private open(): Promise<void> {
    this.closedByUs = false;

    const hadToken = !!this.options.tokenStore.get();
    const timeoutMs = hadToken ? (this.options.connectTimeoutMs ?? 10_000) : (this.options.pairingTimeoutMs ?? 60_000);

    // The TV presents a self-signed certificate for its own IP, so it cannot be verified.
    const socket = new WebSocket(this.buildUrl(), {
      rejectUnauthorized: false,
      handshakeTimeout: Math.min(timeoutMs, 5_000),
      servername: '',
    } as WebSocket.ClientOptions);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let readyFallback: NodeJS.Timeout | undefined;

      const timer = setTimeout(() => {
        fail(
          new ConnectionError(
            hadToken
              ? `Timed out connecting to the TV's ${this.options.endpoint} channel`
              : 'Timed out waiting for pairing. Accept the prompt on the TV, then try again.',
          ),
        );
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(readyFallback);
      };

      const fail = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        socket.terminate();
        reject(error);
      };

      const succeed = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        this.socket = socket;
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.startPing(socket);
        this.log.debug(`[${this.options.endpoint}] connected`);
        resolve();
        this.emit('open');
      };

      socket.on('error', (error) => {
        fail(new ConnectionError(`Could not connect to the TV at ${this.options.host}: ${error.message}`, { cause: error }));
      });

      socket.on('close', () => {
        fail(new ConnectionError(`The TV closed the ${this.options.endpoint} channel while connecting`));
        this.handleClose(socket);
      });

      socket.on('pong', () => {
        this.awaitingPong = false;
      });

      socket.on('message', (raw: RawData, isBinary: boolean) => {
        this.awaitingPong = false;

        if (isBinary) {
          return;
        }

        let message: ChannelMessage;

        try {
          message = JSON.parse(raw.toString()) as ChannelMessage;
        } catch {
          return;
        }

        if (message.event === 'ms.channel.connect') {
          const data = (message.data ?? {}) as { token?: string; id?: string; clients?: Array<{ isHost?: boolean }> };

          if (data.token) {
            this.options.tokenStore.set(String(data.token));
          }

          this.clientId = data.id ?? this.clientId;
          this.ready = false;
          this.hostCount = Array.isArray(data.clients) ? data.clients.filter((client) => client?.isHost).length : undefined;

          if (this.options.readyEvent === 'ms.channel.connect') {
            succeed();
          } else {
            // Some firmware never sends ms.channel.ready; don't hang on it.
            readyFallback = setTimeout(succeed, this.options.readyFallbackMs ?? 2_000);
          }
        } else if (message.event === 'ms.channel.ready') {
          this.ready = true;
          succeed();
          this.emit('ready');
        } else if (message.event === 'ms.channel.clientDisconnect' && (message.data as { isHost?: boolean } | undefined)?.isHost) {
          // The TV-side app left the channel; requests will go unanswered until it announces itself again.
          this.ready = false;
          this.hostCount = 0;
        } else if (message.event === 'ms.channel.unauthorized') {
          fail(
            new UnauthorizedError(
              hadToken
                ? 'The TV rejected the saved pairing token. Remove this device from the TV\'s Device Connection Manager list and pair again.'
                : 'The TV denied the connection. Accept the pairing prompt on the TV.',
            ),
          );
          return;
        } else if (message.event === 'ms.channel.timeOut') {
          fail(new ConnectionError('The pairing prompt on the TV timed out'));
          return;
        } else if (message.event === 'ms.error') {
          this.log.debug(`[${this.options.endpoint}] TV error: ${JSON.stringify(message.data)}`);
        }

        this.emit('message', message);
      });
    });
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }

    this.stopPing();
    this.socket = null;
    this.clientId = undefined;
    this.ready = false;
    this.hostCount = undefined;
    this.log.debug(`[${this.options.endpoint}] disconnected`);
    this.emit('close');

    if (this.keepAlive && !this.closedByUs) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.keepAlive || this.reconnectTimer) {
      return;
    }

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;

      if (!this.keepAlive) {
        return;
      }

      this.connect().catch((error) => {
        this.log.debug(`[${this.options.endpoint}] reconnect failed: ${errorMessage(error)}`);
      });
    }, delay);

    this.reconnectTimer.unref?.();
  }

  /** Ping the TV; if the previous ping got no reply and nothing else arrived, the connection is dead. */
  private startPing(socket: WebSocket): void {
    this.stopPing();
    this.awaitingPong = false;

    this.pingTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (this.awaitingPong) {
        this.log.debug(`[${this.options.endpoint}] no reply to ping, dropping the connection`);
        this.drop(socket);
        return;
      }

      this.awaitingPong = true;
      socket.ping();
    }, this.options.pingIntervalMs ?? 10_000);

    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }
}
