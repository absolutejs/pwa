# @absolutejs/pwa

Framework-agnostic primitives for turning any app into an installable,
push-capable PWA: a **web app manifest**, the **push service worker**, a **VAPID
Web Push sender** that flags dead endpoints, and **browser glue** for
service-worker registration + subscription.

It is storage- and framework-agnostic — _you_ decide how subscriptions are
stored and how routes are mounted. Server helpers live at the root; browser
helpers at `@absolutejs/pwa/client`.

```bash
bun add @absolutejs/pwa
```

## Server

```ts
import {
  createWebAppManifest,
  pushServiceWorker,
  createWebPush,
} from "@absolutejs/pwa";

const ICON = "/icons/app-512.png";

// Serve as application/manifest+json at /manifest.webmanifest
export const manifest = createWebAppManifest({
  name: "My App",
  shortName: "MyApp",
  themeColor: "#6366f1",
  icons: [
    { src: ICON, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: ICON, sizes: "512x512", type: "image/png", purpose: "any" },
  ],
});

// Serve as text/javascript at /sw.js with header `Service-Worker-Allowed: /`
export const sw = pushServiceWorker({ icon: ICON });

// VAPID sender — pass empty/unset keys and it no-ops (isConfigured() === false),
// so push degrades gracefully to your email/in-app fallback.
const push = createWebPush({
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: "mailto:you@example.com",
});

// Fan out to a user's devices; prune whatever it reports gone.
const { gone } = await push.sendMany(subscriptions, {
  title: "New match",
  body: "Acme Co. just replied.",
  url: "/inbox",
});
await pruneEndpoints(gone); // your storage
```

Mounting is yours. With Elysia:

```ts
new Elysia()
  .get("/manifest.webmanifest", ({ set }) => {
    set.headers["content-type"] = "application/manifest+json";
    return manifest;
  })
  .get("/sw.js", ({ set }) => {
    set.headers["content-type"] = "text/javascript";
    set.headers["service-worker-allowed"] = "/";
    return sw;
  });
```

## Client

```ts
import {
  registerServiceWorker,
  getPushStatus,
  subscribeToPush,
  unsubscribeFromPush,
} from "@absolutejs/pwa/client";

// At boot:
await registerServiceWorker(); // defaults to "/sw.js"

// Toggle on: returns the subscription JSON — POST it to your own route.
const subscription = await subscribeToPush(vapidPublicKey);
await fetch("/push/subscribe", { method: "POST", body: JSON.stringify(subscription) });

// Toggle off: returns the endpoint to drop server-side.
const endpoint = await unsubscribeFromPush();
await fetch("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });

const status = await getPushStatus(); // { supported, permission, subscribed }
```

Every client function is feature-safe (no-ops when the APIs are missing or during
SSR). `subscribeToPush` throws `Error("notification-permission-denied")` on a hard
permission denial so you can message it.

## License

MIT
