export class KilnConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KilnConfigError";
  }
}

/** A request the serve process should answer with `statusCode` and the message. */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}
