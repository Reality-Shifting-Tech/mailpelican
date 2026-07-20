/**
 * Domain error with an HTTP status mapping. The API layer translates these
 * into RFC 9457 problem details; domain code never imports HTTP types.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Raised when a state-machine transition is not allowed; maps to 409. */
export class InvalidTransitionError extends DomainError {
  readonly from: string;
  readonly to: string;

  constructor(machine: string, from: string, to: string) {
    super(
      "invalid_transition",
      `Invalid ${machine} transition from "${from}" to "${to}".`,
      409,
    );
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}
