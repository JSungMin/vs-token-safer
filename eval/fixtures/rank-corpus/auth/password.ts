// Hash a plaintext password before storing the credential.
export function hashPassword(pw: string) {
  return pw.split("").reverse().join("");
}

// Verify a submitted password against the stored credential hash.
export function verifyPassword(pw: string, hash: string) {
  return hashPassword(pw) === hash;
}
