// @absolutejs/pwa — framework-agnostic PWA + Web Push primitives (server).
//
// Provides the three server-side pieces every installable, push-capable app
// needs: a web app manifest, the push service-worker script, and a VAPID Web
// Push sender that classifies dead endpoints so you can prune them. It is
// storage- and framework-agnostic: you decide how subscriptions are stored and
// how routes are mounted. The browser glue lives in `@absolutejs/pwa/client`.
import webpush from "web-push";

// ── Web app manifest ────────────────────────────────────────────────────────

export type PwaIcon = {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
};

export type WebAppManifestConfig = {
  name: string;
  shortName: string;
  icons: PwaIcon[];
  description?: string;
  themeColor?: string;
  backgroundColor?: string;
  display?: "standalone" | "fullscreen" | "minimal-ui" | "browser";
  startUrl?: string;
  scope?: string;
};

export type WebAppManifest = {
  name: string;
  short_name: string;
  description?: string;
  icons: PwaIcon[];
  theme_color: string;
  background_color: string;
  display: string;
  start_url: string;
  scope: string;
};

/** Build a spec-shaped web app manifest from a friendly config. Serve the
 *  result as `application/manifest+json` at e.g. `/manifest.webmanifest`. */
export const createWebAppManifest = (
  config: WebAppManifestConfig,
): WebAppManifest => ({
  background_color: config.backgroundColor ?? "#ffffff",
  description: config.description,
  display: config.display ?? "standalone",
  icons: config.icons,
  name: config.name,
  scope: config.scope ?? "/",
  short_name: config.shortName,
  start_url: config.startUrl ?? "/",
  theme_color: config.themeColor ?? "#000000",
});

// ── Service worker ──────────────────────────────────────────────────────────

/** Opt-in offline support for the service worker. When set, the SW precaches the
 *  `fallback` page (+ any `precache` URLs) on install, serves navigations
 *  network-first with the cached fallback when offline, and serves same-origin
 *  requests under `assetPrefix` cache-first (good for content-hashed bundles). */
export type OfflineConfig = {
  /** A precached page served when a navigation fails offline (e.g. "/offline.html"). */
  fallback: string;
  /** Extra same-origin URLs to precache on install. */
  precache?: string[];
  /** Same-origin path prefix to serve cache-first (e.g. "/assets/"). */
  assetPrefix?: string;
  /** Cache bucket name — bump it to invalidate old caches. */
  cacheName?: string;
};

export type ServiceWorkerOptions = {
  /** Icon shown on the notification + as its badge. */
  icon?: string;
  badge?: string;
  /** Enable offline caching + a fallback page. Omit for push-only (no fetch handler). */
  offline?: OfflineConfig;
};

const offlineBlock = (offline: OfflineConfig): string => {
  const cacheName = offline.cacheName ?? "pwa-cache-v1";
  const precache = [offline.fallback, ...(offline.precache ?? [])];
  const assetPrefix = offline.assetPrefix ?? "";

  return `
var PWA_CACHE = ${JSON.stringify(cacheName)};
var PWA_PRECACHE = ${JSON.stringify(precache)};
var PWA_FALLBACK = ${JSON.stringify(offline.fallback)};
var PWA_ASSET_PREFIX = ${JSON.stringify(assetPrefix)};
self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(PWA_CACHE).then(function (c) { return c.addAll(PWA_PRECACHE); }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== PWA_CACHE; }).map(function (k) { return caches.delete(k); }));
  }));
});
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(function () { return caches.match(PWA_FALLBACK); }));
    return;
  }
  if (PWA_ASSET_PREFIX && url.pathname.indexOf(PWA_ASSET_PREFIX) === 0) {
    event.respondWith(caches.match(req).then(function (cached) {
      return cached || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(PWA_CACHE).then(function (c) { c.put(req, copy); });
        return res;
      });
    }));
  }
});`;
};

/** The push service-worker script (a string to serve at e.g. `/sw.js` with a
 *  `Service-Worker-Allowed: /` header). Handles `push` (renders the payload as a
 *  notification) and `notificationclick` (focuses an open tab on the payload's
 *  `url`, or opens it). Pass `offline` to also cache an app shell + fallback
 *  page. The push payload should be JSON: `{ title, body, url, tag, icon, badge }`. */
export const pushServiceWorker = (options: ServiceWorkerOptions = {}): string => {
  const icon = options.icon ?? "";
  const badge = options.badge ?? options.icon ?? "";
  const offline = options.offline ? offlineBlock(options.offline) : "";

  return `${offline}
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'Notification', body: event.data ? event.data.text() : '' }; }
  var title = data.title || 'Notification';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: data.icon || ${JSON.stringify(icon)},
    badge: data.badge || ${JSON.stringify(badge)},
    tag: data.tag,
    data: { url: data.url || '/' }
  }));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        if (client.url.indexOf(target) !== -1 && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
`.trim();
};

// ── Web Push (VAPID) sender ──────────────────────────────────────────────────

export type WebPushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type WebPushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
};

export type WebPushConfig = {
  publicKey: string;
  privateKey: string;
  /** A `mailto:` or URL identifying the application server to push services. */
  subject: string;
};

/** Outcome of one send. `gone` means the push service reported the endpoint
 *  permanently dead (404/410) — drop it from your store. */
export type WebPushSendResult = { ok: boolean; gone: boolean };

// HTTP codes the push service returns for a subscription that no longer exists.
const GONE = 410;
const NOT_FOUND = 404;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Create a Web Push sender bound to your VAPID keys. Pass a partial/empty
 *  config (e.g. unset env) and `isConfigured()` returns false and sends no-op —
 *  so push degrades gracefully to your email/in-app fallback. */
export const createWebPush = (config: Partial<WebPushConfig> = {}) => {
  const configured = Boolean(config.publicKey && config.privateKey);
  if (configured && config.publicKey && config.privateKey) {
    webpush.setVapidDetails(
      config.subject ?? "mailto:admin@example.com",
      config.publicKey,
      config.privateKey,
    );
  }

  const send = async (
    subscription: WebPushSubscription,
    payload: WebPushPayload,
  ): Promise<WebPushSendResult> => {
    if (!configured) return { gone: false, ok: false };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));

      return { gone: false, ok: true };
    } catch (error) {
      const statusCode =
        isRecord(error) && typeof error.statusCode === "number"
          ? error.statusCode
          : 0;

      return {
        gone: statusCode === GONE || statusCode === NOT_FOUND,
        ok: false,
      };
    }
  };

  /** Fan a payload out to many devices. Returns the endpoints that are gone so
   *  the caller can prune them in one batch. */
  const sendMany = async (
    subscriptions: WebPushSubscription[],
    payload: WebPushPayload,
  ): Promise<{ gone: string[] }> => {
    if (!configured || subscriptions.length === 0) return { gone: [] };
    const results = await Promise.all(
      subscriptions.map(async (subscription) => ({
        endpoint: subscription.endpoint,
        result: await send(subscription, payload),
      })),
    );

    return {
      gone: results
        .filter((entry) => entry.result.gone)
        .map((entry) => entry.endpoint),
    };
  };

  return { isConfigured: () => configured, send, sendMany };
};

export type WebPushSender = ReturnType<typeof createWebPush>;
