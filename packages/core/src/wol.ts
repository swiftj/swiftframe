import dgram from 'node:dgram';
import { InvalidArgumentError } from './errors.js';
import { sleep } from './util.js';

export interface WakeOptions {
  /** Broadcast address. Use your subnet's (e.g. 192.168.1.255) if the default does not reach the TV. */
  address?: string;
  port?: number;
  /** How many packets to send; a sleeping TV can miss the first. */
  count?: number;
}

export function buildMagicPacket(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-f]/gi, '');

  if (hex.length !== 12) {
    throw new InvalidArgumentError(`"${mac}" is not a valid MAC address`);
  }

  const address = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => address)]);
}

/** Wake a TV that is fully asleep. Only works if the TV's network card is still listening. */
export async function wake(mac: string, options: WakeOptions = {}): Promise<void> {
  const packet = buildMagicPacket(mac);
  const socket = dgram.createSocket('udp4');

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(() => {
        socket.setBroadcast(true);
        resolve();
      });
    });

    const count = options.count ?? 3;

    for (let i = 0; i < count; i++) {
      await new Promise<void>((resolve, reject) => {
        socket.send(packet, options.port ?? 9, options.address ?? '255.255.255.255', (error) => (error ? reject(error) : resolve()));
      });

      if (i < count - 1) {
        await sleep(100);
      }
    }
  } finally {
    socket.close();
  }
}
