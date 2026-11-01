// The only network code. Each caller is a tool the player asked for, or the data refresh in update.mjs.
export const offline = () => Boolean(process.env.WARFRAME_BUILDS_OFFLINE);

const USER_AGENT = "warframe-builds-mcp (https://github.com/pregamer189/warframe-builds-mcp)";

// Reads the whole body inside the timeout, as a server can stall after sending its headers.
export async function request(url, { timeout = 10000, signal, headers, read = "json" } = {}) {
  if (offline()) throw new Error("Network features are off because WARFRAME_BUILDS_OFFLINE is set.");
  // Written out because AbortSignal.any needs Node 20.
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, timeout);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers }, signal: controller.signal });
    const { ok, status } = response;
    if (!ok) {
      await response.body?.cancel();
      return { ok, status, headers: response.headers };
    }
    return { ok, status, headers: response.headers, body: await response[read]() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}
