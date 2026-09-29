# Bandwidth Hero on Cloudflare Workers

A small [Bandwidth Hero](https://github.com/ayastreb/bandwidth-hero) compression service for Cloudflare Workers. It keeps the extension's `/api/index` endpoint and `url`, `jpeg`, `bw`, and `l` parameters. It also accepts `quality` and `max_width` from newer extensions. The homepage is served as a static asset; image requests invoke the Worker.

Based on the MIT-licensed [himshim/bandwidth-hero-proxy2](https://github.com/himshim/bandwidth-hero-proxy2) Netlify service. This port uses [Cloudflare Image Transformations](https://developers.cloudflare.com/images/optimization/transformations/transform-via-workers/) instead of Sharp, which cannot run as a native module inside a Worker.

## Deploy and publish automatically

1. In Cloudflare, open **Workers & Pages → Create application → Import a repository**. Connect this GitHub repository and select `main`.
2. Leave the build command blank. Set the deploy command to `npx wrangler deploy` if Cloudflare does not fill it in. The root directory is `/`.
3. Ensure the Worker name is `bandwidth-hero-cloudflare`, matching `wrangler.jsonc`. Save and deploy. This publishes both `public/` and `src/worker.js` at a free `workers.dev` address.
4. In **Workers & Pages → bandwidth-hero-cloudflare → Settings → Variables and Secrets**, add a **secret** named `PROXY_KEY`. Use a long random value with letters and numbers. Deploy the new version if Cloudflare asks. Keep this value out of the repository.
5. In the Bandwidth Hero extension, set **Data Compression Service** to `https://bandwidth-hero-cloudflare.<your-subdomain>.workers.dev/api/index/<your-PROXY_KEY>`. The extension checks that URL, then appends `?url=...&jpeg=...&bw=...&l=...` for each image.

After the repository is connected, every push to `main` triggers a Cloudflare build and deploy. This is the same publishing behavior you had with Netlify. Connecting the repository does not copy changes from the original Netlify repository; that code uses a different runtime and needs deliberate porting.

You can add a custom domain under **Settings → Domains & Routes** later. The `workers.dev` address already uses HTTPS.

## Free-plan limits

Cloudflare Workers Static Assets requests are free and unlimited. `/api/*` invokes Worker code; Workers Free permits 100,000 requests per day. Cloudflare Images Free permits 5,000 **unique image transformations per month**. Repeated requests for the same source and settings are cached; after the quota, new transformations fail rather than creating an overage bill. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), and [Images pricing](https://developers.cloudflare.com/images/pricing/).

The Worker defaults to quality `5` and a maximum width of `1080` pixels when the extension supplies neither value. `max_width=0` disables the width cap. The original extension's `l=5` overrides the default. Cloudflare may encode images differently from Sharp, so the resulting byte count may differ.

## Known differences from the Netlify service

- Cloudflare's transform fetch does not provide the original image's byte count. The extension will still display compressed images, but its **bytes saved** counter will not update for these responses.
- This service forwards `Referer`, `User-Agent`, and `Accept-Language` when available. It deliberately does not forward cookies or the user's IP because Cloudflare caches transformed variants. Images that need a logged-in session may fail.
- Some image hosts block requests from Cloudflare or reject hotlinking. The Worker returns that failure rather than sending the large original image to your mobile connection.
- The secret URL limits use to people who know it. Treat it like a password. Cloudflare's free limits still apply if the URL is shared.
- Cloudflare's dashboard preview does not apply real image transforms. Check one public image using the deployed `workers.dev` URL.

## Local editing

Run `npm ci` and `npm run dev`. Local image transformation is a simplified simulation; inspect actual image quality after deployment. `npm run deploy` publishes manually when you are authenticated with Wrangler.
