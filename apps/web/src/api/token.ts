/** The local bearer token (ADR 0017), kept in sessionStorage so it lives only as long as the tab. */

const KEY = "navarch.token";

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return memory;
  }
}

export function setToken(token: string): void {
  memory = token.trim();
  try {
    sessionStorage.setItem(KEY, memory);
  } catch {
    // Storage blocked: keep it in memory for this page.
  }
}

export function clearToken(): void {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

let memory: string | null = null;
