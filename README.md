# @absolutejs/pwa

Framework-agnostic primitives for turning any app into an installable,
offline-capable, push-capable PWA: a **web app manifest**, **finite background
Sync**, the **push service worker**, a **VAPID Web Push sender** that flags dead
endpoints, and **browser glue** for service-worker registration + subscription.

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

// Serve as text/javascript at /sw.js with header `Service-Worker-Allowed: /`.
// Pass `offline` to also precache an app shell + serve a fallback page when a
// navigation fails offline, and cache same-origin assets cache-first.
export const sw = pushServiceWorker({
  icon: ICON,
  offline: { fallback: "/offline.html", assetPrefix: "/assets/" },
  sync: true,
});

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

// At boot. By default this waits for page load, then retries transient
// browser/network failures up to three total attempts.
await registerServiceWorker(); // defaults to "/sw.js"

// Toggle on: returns the subscription JSON — send it through your typed API.
const subscription = await subscribeToPush(vapidPublicKey);
await api.push.subscriptions.post(subscription);

// Toggle off: returns the endpoint to drop server-side.
const endpoint = await unsubscribeFromPush();
await api.push.subscriptions.delete({ endpoint });

const status = await getPushStatus(); // { supported, permission, subscribed }
```

### Offline Sync

`@absolutejs/pwa` can provision `@absolutejs/sync` automatically for an
authenticated browser app. Generate the worker with `sync: true`, then enable
the client bridge during registration:

```ts
await registerServiceWorker("/sw.js", { sync: {} });
```

With `@absolutejs/auth` and `syncSocket()` mounted, no page-level token or
collection list is needed. The client performs a strict same-origin JSON `POST`
to `/__absolute/sync/principal` using the existing HTTP-only session cookie. The
response contains only an opaque account namespace. Foreground Sync clients and
the worker share a namespaced IndexedDB store; the worker discovers persisted
`id`-keyed collection descriptors, flushes the durable outbox, and pulls finite
updates through `/__absolute/sync/background`.

Background Sync is best-effort because browser support and scheduling vary.
Online, focus, and visible-page events also reconnect and flush active clients,
so foreground/resume remains the correctness path. Native apps continue using
their Bearer-based Auth transport rather than this cookie-session bridge.

Advanced endpoints, limits, and the shared database name are configurable:

```ts
await registerServiceWorker("/sw.js", {
  sync: {
    endpoint: "/__absolute/sync/background",
    principalEndpoint: "/__absolute/sync/principal",
    databaseName: "absolutejs-sync-v1",
    maxMutations: 50,
    maxPulls: 50,
  },
});
```

Both endpoints must resolve to the page's exact origin and redirects are
refused. Cookies, bearer tokens, mutation arguments, and application rows are
never embedded in the worker script or service-worker messages. If the session
is absent, the worker configuration is cleared. `configurePwaSync()` is also
exported for hosts that register their worker separately.

### Install prompt

Capture the browser's install signal and drive it from your own button:

```ts
import {
  initInstallPrompt,
  onInstallable,
  promptInstall,
  canInstall,
} from "@absolutejs/pwa/client";

initInstallPrompt(); // once at boot

// React to availability (show/hide your install button):
const off = onInstallable((installable) => setShowInstall(installable));

// From a click handler (must be a user gesture):
const accepted = await promptInstall();
```

### Embedded browsers and capability UX

Feature-detect before offering browser-dependent actions, then use embedded-
browser identity only to explain an unavailable capability:

```ts
import {
  detectEmbeddedBrowser,
  getBrowserCapabilities,
} from "@absolutejs/pwa/client";

const capabilities = getBrowserCapabilities();
if (!capabilities.pushNotifications && capabilities.embeddedBrowser) {
  showOpenInBrowserHelp(capabilities.embeddedBrowser.app);
}

// Pure user-agent classification is also available for SSR/tests.
detectEmbeddedBrowser(request.headers.get("user-agent") ?? "");
```

Detection is deliberately conservative: Facebook, Instagram, and Messenger are
identified only from their explicit host-app markers. Unknown WebViews return
`null`; capability checks remain authoritative.

### App update prompt

One latched update flow handles both waiting service workers and release probes.
Detection never reloads the page; only the user's update action does:

```ts
import {
  announceUpdateAvailable,
  applyUpdate,
  checkForUpdate,
  onUpdateAvailable,
} from "@absolutejs/pwa/client";

// Render your framework's branded prompt. A signal received before this
// subscription is retained and delivered immediately.
const off = onUpdateAvailable(() => showUpdatePrompt());

// Bridge any release detector, including @absolutejs/beacon's releaseProbe:
const onStale = (release: { currentRelease: string; newestRelease: string }) =>
  announceUpdateAvailable({ ...release, source: "release-probe" });

// Safe to call on focus, visibility change, or an interval.
await checkForUpdate();

// Call only from the prompt's button. This activates a waiting worker when one
// exists, then performs exactly one bounded reload.
await applyUpdate();
```

The service worker must be built without `skipWaiting` (the default) so it waits
for explicit user consent. Repeated release-probe and service-worker signals
merge into one prompt instead of creating competing reload paths.

Every client function is feature-safe (no-ops when the APIs are missing or during
SSR). `subscribeToPush` throws `Error("notification-permission-denied")` on a hard
permission denial so you can message it.

## License

MIT
