export class RedTeamError extends Error {
  override name = "RedTeamError";
}
export class CredentialError extends RedTeamError {
  override name = "CredentialError";
}
export class BackendError extends RedTeamError {
  override name = "BackendError";
}
export class DatasetError extends RedTeamError {
  override name = "DatasetError";
}
export class CancelledError extends RedTeamError {
  override name = "CancelledError";
}
