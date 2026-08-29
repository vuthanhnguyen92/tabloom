export class CimdFetchError extends Error {
  constructor(message = "CIMD client metadata could not be validated") {
    super(message);
    this.name = "CimdFetchError";
  }
}

export class CimdUnavailableError extends CimdFetchError {
  constructor(message = "CIMD client metadata is temporarily unavailable") {
    super(message);
    this.name = "CimdUnavailableError";
  }
}
