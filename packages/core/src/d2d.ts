import net from 'node:net';
import tls from 'node:tls';
import { ConnectionError } from './errors.js';
import { sleep } from './util.js';

/**
 * Images do not travel over the WebSocket. The TV answers an upload or thumbnail request with the
 * address of a short-lived TCP socket ("D2D"), and the file is exchanged there with a small
 * length-prefixed JSON header in front of the bytes.
 */
export interface D2dConnInfo {
  ip: string;
  port: number | string;
  key?: string;
  secured?: boolean;
  [key: string]: unknown;
}

export interface D2dFile {
  id: string;
  type: string;
  data: Buffer;
}

/** The TV needs a moment before its TLS socket accepts connections. */
const SECURED_CONNECT_DELAY_MS = 1_000;
const SOCKET_TIMEOUT_MS = 30_000;

async function openSocket(info: D2dConnInfo): Promise<net.Socket> {
  const port = Number(info.port);

  if (info.secured) {
    await sleep(SECURED_CONNECT_DELAY_MS);
  }

  return new Promise<net.Socket>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(new ConnectionError(`Could not open the TV's transfer socket: ${error.message}`, { cause: error }));
    };

    // Self-signed certificate for the TV's own IP; it cannot be verified.
    const socket: net.Socket = info.secured
      ? tls.connect({ host: info.ip, port, rejectUnauthorized: false }, () => ready())
      : net.connect({ host: info.ip, port }, () => ready());

    const ready = () => {
      socket.off('error', onError);
      resolve(socket);
    };

    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy(new Error('transfer socket timed out')));
    socket.once('error', onError);
  });
}

/** Send one image to the TV over its transfer socket. */
export async function sendFile(info: D2dConnInfo, data: Buffer, fileType: string): Promise<void> {
  const socket = await openSocket(info);

  const header = Buffer.from(
    JSON.stringify({
      num: 0,
      total: 1,
      fileLength: data.length,
      fileName: 'swiftframe',
      fileType,
      secKey: info.key,
      version: '0.0.1',
    }),
    'ascii',
  );

  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);

  await new Promise<void>((resolve, reject) => {
    socket.once('error', (error) => reject(new ConnectionError(`Upload failed: ${error.message}`, { cause: error })));
    socket.write(length);
    socket.write(header);
    socket.end(data, () => resolve());
  });
}

/** Pull exact byte counts out of a socket that delivers arbitrary chunks. */
class SocketReader {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake?.();
    });

    socket.on('end', () => {
      this.ended = true;
      this.wake?.();
    });

    socket.on('close', () => {
      this.ended = true;
      this.wake?.();
    });

    socket.on('error', (error) => {
      this.error = error;
      this.wake?.();
    });
  }

  /** Resolves with exactly `size` bytes, or null if the socket ended cleanly before any arrived. */
  async read(size: number): Promise<Buffer | null> {
    while (this.buffer.length < size) {
      if (this.error) {
        throw new ConnectionError(`Transfer failed: ${this.error.message}`, { cause: this.error });
      }

      if (this.ended) {
        if (this.buffer.length === 0) {
          return null;
        }

        throw new ConnectionError('The TV closed the transfer socket mid-file');
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }

    const chunk = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return chunk;
  }
}

/** Read every file the TV sends on a transfer socket (used for thumbnails). */
export async function receiveFiles(info: D2dConnInfo): Promise<D2dFile[]> {
  const socket = await openSocket(info);
  const reader = new SocketReader(socket);
  const files: D2dFile[] = [];

  try {
    let total = 1;

    while (files.length < total) {
      const lengthBytes = await reader.read(4);

      if (!lengthBytes) {
        break;
      }

      const headerBytes = await reader.read(lengthBytes.readUInt32BE());

      if (!headerBytes) {
        break;
      }

      const header = JSON.parse(headerBytes.toString('utf8')) as {
        fileLength: number | string;
        total?: number | string;
        fileID?: string;
        fileType?: string;
      };

      total = Number(header.total ?? 1);

      const data = await reader.read(Number(header.fileLength));

      if (!data) {
        break;
      }

      files.push({ id: String(header.fileID ?? ''), type: String(header.fileType ?? 'jpg'), data: Buffer.from(data) });
    }
  } finally {
    socket.destroy();
  }

  return files;
}
