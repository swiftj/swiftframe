import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenStore } from './types.js';

export class MemoryTokenStore implements TokenStore {
  constructor(private token?: string) {}

  get(): string | undefined {
    return this.token;
  }

  set(token: string): void {
    this.token = token;
  }
}

/**
 * Keeps the pairing token in a small file readable only by the current user.
 * The token lets anyone on the network control the TV, so treat the file like a password.
 */
export class FileTokenStore implements TokenStore {
  private cached?: string;

  constructor(private readonly path: string) {}

  get(): string | undefined {
    if (this.cached) {
      return this.cached;
    }

    try {
      const token = readFileSync(this.path, 'utf8').trim();
      this.cached = token || undefined;
    } catch {
      this.cached = undefined;
    }

    return this.cached;
  }

  set(token: string): void {
    this.cached = token;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${token}\n`, { mode: 0o600 });
  }
}
