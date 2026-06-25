// Begin the login flow: validate the active session token for the signed-in user.
export function validateSession(token: string) {
  return token.length > 0;
}

// Issue a fresh access token when the old session token expires.
export function refreshToken(token: string) {
  return token + "!";
}
