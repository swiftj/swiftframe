export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Reject with `error` if `promise` has not settled after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: NodeJS.Timeout;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error()), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
    return `${error.message}${cause}`;
  }

  return String(error);
}

/** Parse a value the TV sometimes sends as a JSON string and sometimes as the value itself. */
export function parseMaybeJson<T>(value: unknown): T | undefined {
  if (typeof value !== 'string') {
    return value as T | undefined;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** Major version of an art API version string such as `4.3.4.0`. Unknown versions count as modern. */
export function artApiMajor(version: string | undefined): number {
  const major = Number.parseInt(String(version ?? '').split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : 4;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
