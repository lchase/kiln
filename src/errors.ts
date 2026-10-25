export class KilnConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KilnConfigError";
  }
}
