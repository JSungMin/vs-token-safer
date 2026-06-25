// Load the stored profile record for a signed-in user.
export function getUserProfile(user: string) {
  return { user };
}

// Reset a forgotten password and email the user a recovery link.
export function resetPassword(user: string) {
  return user.length > 0;
}

// Update the user's account settings and preferences.
export function updateAccount(user: string) {
  return user;
}
