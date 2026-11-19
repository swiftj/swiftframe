import { ConnectionError } from './errors.js';
import type { DeviceInfo } from './types.js';

interface RawDeviceInfo {
  name?: string;
  version?: string;
  device?: {
    name?: string;
    model?: string;
    modelName?: string;
    wifiMac?: string;
    firmwareVersion?: string;
    FrameTVSupport?: string;
    TokenAuthSupport?: string;
    PowerState?: string;
    [key: string]: unknown;
  };
}

/**
 * Ask the TV what it is. This endpoint needs no pairing and keeps answering in standby,
 * which makes it the cheapest way to tell on, standby and unreachable apart.
 */
export async function getDeviceInfo(host: string, options: { port?: number; timeoutMs?: number } = {}): Promise<DeviceInfo> {
  const url = `http://${host}:${options.port ?? 8001}/api/v2/`;
  let raw: RawDeviceInfo;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 2_000) });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    raw = (await response.json()) as RawDeviceInfo;
  } catch (error) {
    const reason = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
    throw new ConnectionError(`The TV at ${host} did not answer: ${reason}`, { cause: error });
  }

  const device = raw.device ?? {};

  return {
    name: device.name ?? raw.name,
    model: device.model,
    modelName: device.modelName,
    firmware: device.firmwareVersion ?? raw.version,
    wifiMac: device.wifiMac,
    frameSupport: device.FrameTVSupport === 'true',
    tokenSupport: device.TokenAuthSupport === 'true',
    powerState: device.PowerState,
    raw,
  };
}
