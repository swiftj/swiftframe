import { ConnectionError } from './errors.js';
import { clamp } from './util.js';

const SERVICE = 'urn:schemas-upnp-org:service:RenderingControl:1';

/**
 * Volume and mute through the TV's UPnP RenderingControl service.
 * This is the only local way to read the volume or set it to an exact level.
 * It only reports the TV's own speakers; with a soundbar the TV may ignore it.
 */
export class VolumeClient {
  private readonly controlUrl: string;

  constructor(host: string, options: { port?: number } = {}) {
    this.controlUrl = `http://${host}:${options.port ?? 9197}/upnp/control/RenderingControl1`;
  }

  public async getVolume(): Promise<number> {
    const body = await this.action('GetVolume', { InstanceID: 0, Channel: 'Master' });
    return Number(extract(body, 'CurrentVolume'));
  }

  public async setVolume(level: number): Promise<void> {
    await this.action('SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: clamp(Math.round(level), 0, 100) });
  }

  public async getMute(): Promise<boolean> {
    const body = await this.action('GetMute', { InstanceID: 0, Channel: 'Master' });
    return extract(body, 'CurrentMute') === '1';
  }

  public async setMute(muted: boolean): Promise<void> {
    await this.action('SetMute', { InstanceID: 0, Channel: 'Master', DesiredMute: muted ? 1 : 0 });
  }

  private async action(name: string, args: Record<string, string | number>): Promise<string> {
    const argsXml = Object.entries(args)
      .map(([key, value]) => `<${key}>${value}</${key}>`)
      .join('');

    const envelope =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body><u:${name} xmlns:u="${SERVICE}">${argsXml}</u:${name}></s:Body>` +
      '</s:Envelope>';

    try {
      const response = await fetch(this.controlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${SERVICE}#${name}"` },
        body: envelope,
        signal: AbortSignal.timeout(3_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      const reason = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
      throw new ConnectionError(`Volume control failed (${name}): ${reason}`, { cause: error });
    }
  }
}

function extract(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml);

  if (!match) {
    throw new ConnectionError(`The TV's reply did not include ${tag}`);
  }

  return match[1]!.trim();
}
