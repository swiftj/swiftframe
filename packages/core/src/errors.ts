export class FrameError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The TV could not be reached, or the connection dropped. */
export class ConnectionError extends FrameError {}

/** The TV refused the connection. The pairing prompt was denied, or the saved token is no longer accepted. */
export class UnauthorizedError extends FrameError {}

/** The TV did not answer a request in time. */
export class RequestTimeoutError extends FrameError {}

/** The TV answered an art request with an error code. */
export class ArtRequestError extends FrameError {
  constructor(
    public readonly request: string,
    public readonly code: string | number,
  ) {
    super(`The TV rejected the art request "${request}" (error ${code})`);
  }
}

/** The art service stopped answering, so requests are paused for a while instead of piling up. */
export class ArtServiceUnavailableError extends FrameError {
  constructor(public readonly retryInMs: number) {
    super(`The TV's art service is not answering; retry in ${Math.ceil(retryInMs / 1000)}s`);
  }
}

/** The request needs a Frame TV and this TV is not one. */
export class NotAFrameError extends FrameError {
  constructor() {
    super('This TV does not report Art Mode support');
  }
}

export class InvalidArgumentError extends FrameError {}
