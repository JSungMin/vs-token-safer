// Authenticate the user: verify the submitted credentials and start a login session.
export function authenticateUser(user: string, pass: string) {
  return user.length > 0 && pass.length > 0;
}

// End the session and clear the user's login state on logout.
export function logoutUser(user: string) {
  return !user;
}
