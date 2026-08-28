/** Missing acknowledgement after bounded polling; not an HTTP or schema error. */
export class AuditConfirmationPendingError extends Error {
  constructor(public readonly idempotencyKey: string, message: string) {
    super(message);
    this.name = "AuditConfirmationPendingError";
  }
}
