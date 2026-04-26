import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { shell } from "electron";
import { loadTokens, saveTokens, clearTokens, type StoredTokens } from "./storage.js";

const CLIENT_ID = process.env.YOTO_CLIENT_ID || "A1c4Noo77MdN7CB8QjUOvwtdyMZnSwkd";
const AUTH_BASE = "https://login.yotoplay.com";
const AUDIENCE = "https://api.yotoplay.com";
const SCOPE = "openid profile offline_access";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

let pollAbort: AbortController | null = null;

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch(`${AUTH_BASE}/oauth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
      audience: AUDIENCE,
    }),
  });
  if (!res.ok) throw new Error(`device code request failed: ${res.status}`);
  return res.json() as Promise<DeviceCodeResponse>;
}

async function pollToken(deviceCode: string, interval: number, expiresIn: number, signal: AbortSignal): Promise<TokenResponse> {
  const deadline = Date.now() + expiresIn * 1000;
  let wait = Math.max(interval, 1) * 1000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("aborted");
    await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: CLIENT_ID,
      }),
    });
    if (res.ok) return res.json() as Promise<TokenResponse>;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      wait += 5000;
      continue;
    }
    throw new Error(`token poll failed: ${body.error || res.status}`);
  }
  throw new Error("authorization timed out");
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
  return res.json() as Promise<TokenResponse>;
}

export async function getValidAccessToken(): Promise<string | null> {
  const tokens = await loadTokens();
  if (!tokens) return null;
  if (tokens.expiresAt && Date.now() < tokens.expiresAt - 60_000) return tokens.accessToken;
  try {
    const fresh = await refreshAccessToken(tokens.refreshToken);
    const updated: StoredTokens = {
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token || tokens.refreshToken,
      expiresAt: Date.now() + fresh.expires_in * 1000,
    };
    await saveTokens(updated);
    return updated.accessToken;
  } catch {
    return null;
  }
}

export function registerAuthHandlers(ipc: IpcMain): void {
  ipc.handle("auth:status", async () => {
    const token = await getValidAccessToken();
    return { signedIn: !!token };
  });

  ipc.handle("auth:start", async (event: IpcMainInvokeEvent) => {
    pollAbort?.abort();
    pollAbort = new AbortController();

    const code = await requestDeviceCode();
    shell.openExternal(code.verification_uri_complete);

    (async () => {
      try {
        const tokens = await pollToken(code.device_code, code.interval, code.expires_in, pollAbort!.signal);
        await saveTokens({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
        });
        event.sender.send("auth:complete", { ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        event.sender.send("auth:complete", { ok: false, error: message });
      }
    })();

    return {
      userCode: code.user_code,
      verificationUri: code.verification_uri,
      verificationUriComplete: code.verification_uri_complete,
    };
  });

  ipc.handle("auth:cancel", async () => {
    pollAbort?.abort();
    pollAbort = null;
  });

  ipc.handle("auth:signout", async () => {
    pollAbort?.abort();
    pollAbort = null;
    await clearTokens();
  });
}
