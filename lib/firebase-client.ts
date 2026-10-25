"use client";

const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const appUrl = process.env.NEXT_PUBLIC_APP_URL;

function endpoint(path: string) {
  if (!apiKey) throw new Error("Firebase is not configured yet.");
  return `https://identitytoolkit.googleapis.com/v1/${path}?key=${apiKey}`;
}

async function call(path: string, body: Record<string, unknown>) {
  const response = await fetch(endpoint(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => ({})) as { error?: { message?: string } } & Record<string, unknown>;
  if (!response.ok) throw new Error(json.error?.message ?? "Authentication failed.");
  return json;
}

export async function firebaseSignUp(email: string, password: string) { return call("accounts:signUp", { email, password, returnSecureToken: true }) as Promise<{ idToken: string }>; }
export async function firebaseSignIn(email: string, password: string) { return call("accounts:signInWithPassword", { email, password, returnSecureToken: true }) as Promise<{ idToken: string }>; }
export async function sendVerification(idToken: string) { return call("accounts:sendOobCode", { requestType: "VERIFY_EMAIL", idToken, continueUrl: `${appUrl}/login?verified=1`, canHandleCodeInApp: false }); }
export async function sendPasswordReset(email: string) { return call("accounts:sendOobCode", { requestType: "PASSWORD_RESET", email, continueUrl: `${appUrl}/login`, canHandleCodeInApp: false }); }
export async function confirmPasswordReset(oobCode: string, newPassword: string) { return call("accounts:resetPassword", { oobCode, newPassword }); }
