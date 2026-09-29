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

function redirectToSource(url, reason = "upstream-error") {
  const original = new URL(url);
  original.hash = "";
  return new Response(null, {
    status: 302,
    headers: { ...cors, "Cache-Control": "no-store", "Location": original.toString(), "X-Proxy-Fallback": reason },
  });
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
    const hathImagePort = url.protocol === "https:" && url.port === "2333" &&
      (host === "hath.network" || host.endsWith(".hath.network"));
    if (url.username || url.password || (url.port && !hathImagePort)) return null;
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

function isComixOrigin(value) {
  if (!value) return false;
  try {
    const origin = new URL(value);
    const host = origin.hostname.toLowerCase().replace(/\.$/, "");
    return ["comix.to", "comix.ws"].some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function comixMode(request, imageUrl) {
  const v3 = imageUrl.searchParams.has("v3");
  const origin = request.headers.get("Origin");
  const legacy = !v3 && (imageUrl.hash === "#scrambled" || isComixOrigin(origin));
  return { bypassTransform: v3 || legacy, forwardOrigin: legacy && isComixOrigin(origin) };
}

function imageUrlParameter(requestUrl, params) {
  if (!params.has("jpg")) return params.get("url");

  // Komikku appends its source URL last without escaping its query separators.
  const rawQuery = requestUrl.search.slice(1);
  const marker = rawQuery.indexOf("&url=");
  if (marker < 0) return params.get("url");

  const value = rawQuery.slice(marker + "&url=".length);
  if (/^https?:\/\//i.test(value)) return value;
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return value;
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
    const imageUrl = sourceUrl(imageUrlParameter(requestUrl, params), requestUrl.hostname.toLowerCase());
    if (!imageUrl) return reply("Invalid image URL", 400);

    // Some Comix image hosts reject Cloudflare's outbound IPs. Keep the
    // Egypt-reachable Worker as Komikku's entry point and use the existing
    // Netlify function only for fetching those images server to server.
    if (/\.cipher-vault-alpha\.site$/i.test(imageUrl.hostname)) {
      try {
        const backend = new URL("https://mellifluous-baklava-3f154e.netlify.app/api/index");
        backend.searchParams.set("url", imageUrl.toString());
        backend.searchParams.set("jpeg", params.get("jpg") === "1" ? "1" : "0");
        backend.searchParams.set("l", params.get("l") ?? "40");
        backend.searchParams.set("bw", params.get("bw") ?? "0");
        const backendHeaders = new Headers();
        const origin = request.headers.get("Origin");
        if (isComixOrigin(origin)) backendHeaders.set("Origin", origin);
        const backendResponse = await fetch(backend, { headers: backendHeaders, redirect: "manual" });
        if (backendResponse.ok && backendResponse.headers.get("Content-Type")?.startsWith("image/")) {
          const resultHeaders = new Headers(cors);
          for (const name of ["Content-Type", "Content-Length", "X-Enc-Seed", "X-Enc-Len", "X-Enc-Algo", "X-Scramble-Seed", "X-Scramble-Grid", "X-Scramble-Algo", "X-Scramble-Hash"]) {
            const value = backendResponse.headers.get(name);
            if (value) resultHeaders.set(name, value);
          }
          resultHeaders.set("Access-Control-Expose-Headers", "X-Enc-Seed, X-Enc-Len, X-Enc-Algo, X-Scramble-Seed, X-Scramble-Grid, X-Scramble-Algo, X-Scramble-Hash");
          return new Response(backendResponse.body, { status: 200, headers: resultHeaders });
        }
      } catch (error) {
        console.error("Comix backend fetch failed", error);
      }
      return redirectToSource(imageUrl, "comix-backend-error");
    }

    const quality = integer(params.get("quality") ?? params.get("l"), 5, 1, 100);
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
    // Comix image hosts reject requests without a Comix site header. Komikku
    // removes Origin when its image URL points at this proxy.
    if (/\.cipher-vault-alpha\.site$/i.test(imageUrl.hostname) && !headers.has("Referer")) {
      headers.set("Referer", "https://comix.to/");
    }
    const { bypassTransform, forwardOrigin } = comixMode(request, imageUrl);
    if (forwardOrigin) headers.set("Origin", request.headers.get("Origin"));

    try {
      const upstream = await fetch(new Request(imageUrl.toString(), { headers }), bypassTransform ? undefined : {
        cf: { image },
      });
      if (!upstream.ok) return redirectToSource(imageUrl, `upstream-${upstream.status}`);
      // Cloudflare caches transformed variants using the source URL and options.
      // Never forward upstream cookies or arbitrary response headers.
      const responseHeaders = new Headers();
      const safeHeaders = ["Content-Type", "Content-Length", "Cache-Control", "Etag", "Last-Modified"];
      if (bypassTransform) {
        // Komikku's Comix source reads these response headers to decode encrypted
        // bytes and descramble V3 image tiles after the HTTP response arrives.
        safeHeaders.push(
          "X-Enc-Seed", "X-Enc-Len", "X-Enc-Algo",
          "X-Scramble-Seed", "X-Scramble-Grid", "X-Scramble-Algo", "X-Scramble-Hash",
        );
      }
      for (const name of safeHeaders) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      for (const [name, value] of Object.entries(cors)) responseHeaders.set(name, value);
      responseHeaders.set("Access-Control-Expose-Headers", "X-Enc-Seed, X-Enc-Len, X-Enc-Algo, X-Scramble-Seed, X-Scramble-Grid, X-Scramble-Algo, X-Scramble-Hash");
      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error("Image proxy fetch failed", error);
      return redirectToSource(imageUrl, "fetch-error");
    }
  },
};
