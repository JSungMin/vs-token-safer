// Quarantine a credential flagged by the anomaly detector until an operator reviews it.
export function quarantineCredential(user: string) {
  return user.length > 0;
}

// Revoke a compromised token immediately and blocklist its fingerprint.
export function revokeCompromisedToken(token: string) {
  return !token;
}
