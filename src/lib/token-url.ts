import Constants from "expo-constants";

const DEFAULT_PORT = 8787;

/**
 * The iOS simulator shares localhost with the Mac, but a physical Android device
 * does not. Metro already knows the Mac's LAN address, so reuse that host.
 */
export function resolveServerBaseUrl(): string {
  const override = process.env.EXPO_PUBLIC_TOKEN_URL;
  if (override) {
    return new URL(override).origin;
  }

  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost;
  const host = hostUri?.split(":")[0];

  return `http://${host ?? "localhost"}:${DEFAULT_PORT}`;
}

export function resolveTokenUrl(): string {
  return `${resolveServerBaseUrl()}/token`;
}

/** The Expo Audio tab talks only to the local relay. */
export function resolveVoiceSocketUrl(): string {
  const url = new URL("/voice", resolveServerBaseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function fetchEphemeralKey(): Promise<string> {
  const url = resolveTokenUrl();
  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token server ${response.status} at ${url}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { value?: string };
  if (!data.value) {
    throw new Error(`Token server at ${url} returned no client secret`);
  }

  return data.value;
}
