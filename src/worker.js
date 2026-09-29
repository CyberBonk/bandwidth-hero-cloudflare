// Cloudflare Workers port of the Bandwidth Hero compression endpoint.
// The original extension appends ?url=...&jpeg=...&bw=...&l=... to its proxy URL.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function reply(message, status = 200) {
  return new Response(message, { status, headers: { ...cors, "Cache-Control": "no-store" } });
}

function integer(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function sourceUrl(value, workerHost) {
  if (!value) return null;
  let raw = value;
  try {
    const decoded = JSON.parse(value);
    if (typeof decoded === "string") raw = decoded;
  } catch { /* Normal URL, not JSON. */ }
  if (typeof raw !== "string") return null;
  raw = raw.replace(/http:\/\/1\.1\.\d\.\d\/bmi\/(https?:\/\/)?/i, "http://");

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password || url.port) return null;
    if (host === workerHost || host === "localhost" || host.endsWith(".localhost") ||
        host.endsWith(".local") || host.endsWith(".internal")) return null;
    // Browser image URLs normally use domain names. Reject IP literals to avoid
    // turning this public edge service into a network probe.
    if (host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
    return url;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== "/api/index" && !requestUrl.pathname.startsWith("/api/index/")) {
      return env.ASSETS.fetch(request);
    }
    if (request.method === "OPTIONS") return reply("", 204);
    if (request.method !== "GET") return reply("Method not allowed", 405);

    const key = requestUrl.pathname.slice("/api/index/".length);
    if (!env.PROXY_KEY) return reply("Proxy key is not configured", 503);
    if (![ `/api/index/${env.PROXY_KEY}`, `/api/index/${env.PROXY_KEY}/` ].includes(requestUrl.pathname) || !key) {
      return reply("Forbidden", 403);
    }

    const params = requestUrl.searchParams;
    if (!params.has("url")) return reply("bandwidth-hero-proxy");
    const imageUrl = sourceUrl(params.get("url"), requestUrl.hostname.toLowerCase());
    if (!imageUrl) return reply("Invalid image URL", 400);

    const requestedQuality = integer(params.get("quality") ?? params.get("l"), 5, 1, 100);
    // Komikku's lowest UI setting is 10%; keep its reader images at 5%.
    const quality = params.has("jpg") ? Math.min(requestedQuality, 5) : requestedQuality;
    const requestedWidth = integer(params.get("max_width"), 1080, 0, 4096);
    const image = {
      fit: "scale-down",
      quality,
      format: params.get("jpeg") === "1" || params.get("jpg") === "1" ? "jpeg" : "webp",
      metadata: "none",
    };
    if (requestedWidth > 0) image.width = requestedWidth;
    if (params.get("bw") === "1") image.saturation = 0;

    const headers = new Headers();
    headers.set("Accept", "image/avif,image/webp,image/*,*/*;q=0.8");
    for (const name of ["Referer", "User-Agent", "Accept-Language"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    try {
      const transformed = await fetch(new Request(imageUrl.toString(), { headers }), {
        cf: { image },
      });
      // Cloudflare caches transformed variants using the source URL and options.
      // Never forward upstream cookies or arbitrary response headers.
      const responseHeaders = new Headers();
      for (const name of ["Content-Type", "Content-Length", "Cache-Control", "Etag", "Last-Modified"]) {
        const value = transformed.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      for (const [name, value] of Object.entries(cors)) responseHeaders.set(name, value);
      return new Response(transformed.body, {
        status: transformed.status,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error("Image transformation failed", error);
      return reply("Image transformation failed", 502);
    }
  },
};
