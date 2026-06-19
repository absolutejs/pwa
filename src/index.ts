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

/** An app shortcut — a jump target the OS exposes on the icon's context menu
 *  (right-click the dock/taskbar icon, long-press on mobile). */
export type WebAppShortcut = {
  name: string;
  short_name?: string;
  description?: string;
  url: string;
  icons?: PwaIcon[];
};

/** Register the app as an OS share target. The OS posts the shared content to
 *  `action`; `params` maps the shared title/text/url onto your query/form keys. */
export type WebShareTarget = {
  action: string;
  method?: "GET" | "POST";
  enctype?: string;
  params: { title?: string; text?: string; url?: string };
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
  shortcuts?: WebAppShortcut[];
  shareTarget?: WebShareTarget;
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
  shortcuts?: WebAppShortcut[];
  share_target?: WebShareTarget;
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
  ...(config.shareTarget ? { share_target: config.shareTarget } : {}),
  short_name: config.shortName,
  ...(config.shortcuts ? { shortcuts: config.shortcuts } : {}),
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

/** Re-register a rotated push subscription with no app open. Browsers
 *  occasionally rotate a push subscription's keys and fire
 *  `pushsubscriptionchange`; without handling it, the old endpoint silently
 *  goes dead and the user stops getting push. With this set, the worker
 *  re-subscribes with the same VAPID key and POSTs the fresh subscription
 *  (`{ endpoint, keys }`, with cookies) back to the server. */
export type PushResubscribeConfig = {
  /** VAPID public key (base64url) — same one passed to `subscribeToPush`. */
  applicationServerKey: string;
  /** Same-origin endpoint that persists a subscription (the one the client
   *  POSTs to on enable). Receives `{ endpoint, keys: { p256dh, auth } }`. */
  subscribeUrl: string;
};

export type ServiceWorkerOptions = {
  /** Icon shown on the notification + as its badge. */
  icon?: string;
  badge?: string;
  /** Enable offline caching + a fallback page. Omit for push-only (no fetch handler). */
  offline?: OfflineConfig;
  /** Activate a new worker immediately on install (default false). Leave false to
   *  support an in-app "new version — reload" prompt: the new SW waits until the
   *  client posts `SKIP_WAITING` (via applyUpdate). A fresh first install still
   *  activates right away regardless. */
  skipWaiting?: boolean;
  /** Auto-recover a rotated push subscription via `pushsubscriptionchange`. */
  resubscribe?: PushResubscribeConfig;
};

const resubscribeBlock = (resubscribe: PushResubscribeConfig): string => `
var PWA_VAPID_KEY = ${JSON.stringify(resubscribe.applicationServerKey)};
var PWA_SUBSCRIBE_URL = ${JSON.stringify(resubscribe.subscribeUrl)};
function pwaB64ToUint8(base64) {
  var padding = '='.repeat((4 - base64.length % 4) % 4);
  var b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  var raw = self.atob(b64);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
// The browser rotated our subscription → re-subscribe with the same VAPID key
// and re-register the fresh endpoint so push keeps flowing.
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: pwaB64ToUint8(PWA_VAPID_KEY)
    }).then(function (sub) {
      var json = sub.toJSON();
      return fetch(PWA_SUBSCRIBE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ endpoint: sub.endpoint, keys: json.keys })
      });
    }).catch(function () {})
  );
});`;

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
 *  `url`, or opens it). If the payload carries `actions` + `actionRequests`, the
 *  notification renders buttons and tapping one fires the matching authenticated
 *  request (same-origin, with cookies) instead of opening a tab. Pass `offline`
 *  to also cache an app shell + fallback page, or `resubscribe` to auto-recover
 *  a browser-rotated subscription. The push payload should be JSON:
 *  `{ title, body, url, tag, icon, badge, actions, actionRequests }`. */
export const pushServiceWorker = (
  options: ServiceWorkerOptions = {},
): string => {
  const icon = options.icon ?? "";
  const badge = options.badge ?? options.icon ?? "";
  const offline = options.offline ? offlineBlock(options.offline) : "";
  const resubscribe = options.resubscribe
    ? resubscribeBlock(options.resubscribe)
    : "";

  const installBody = options.skipWaiting ? "self.skipWaiting();" : "";

  return `${offline}${resubscribe}
self.addEventListener('install', function () { ${installBody} });
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
// The client posts this (applyUpdate) to swap to a freshly-installed worker.
self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING' || (event.data && event.data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'Notification', body: event.data ? event.data.text() : '' }; }
  // Reflect an unread count onto the app icon, even when no window is open.
  if (typeof data.badgeCount === 'number' && self.navigator && self.navigator.setAppBadge) {
    if (data.badgeCount > 0) self.navigator.setAppBadge(data.badgeCount);
    else if (self.navigator.clearAppBadge) self.navigator.clearAppBadge();
  }
  var title = data.title || 'Notification';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: data.icon || ${JSON.stringify(icon)},
    badge: data.badge || ${JSON.stringify(badge)},
    tag: data.tag,
    actions: Array.isArray(data.actions) ? data.actions : [],
    data: { url: data.url || '/', actionRequests: data.actionRequests || {} }
  }));
});
self.addEventListener('notificationclick', function (event) {
  var d = event.notification.data || {};
  var reqs = d.actionRequests || {};
  // An action button with a configured request → fire it (same-origin, with
  // cookies) and dismiss, without opening a tab. The server re-checks the caller.
  if (event.action && reqs[event.action]) {
    var r = reqs[event.action];
    event.notification.close();
    event.waitUntil(
      fetch(r.url, {
        method: r.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(r.body || {})
      }).catch(function () {})
    );
    return;
  }
  event.notification.close();
  var target = d.url || '/';
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

/** A notification action button (rendered by the OS under the notification). */
export type WebPushAction = {
  /** Identifies the button; echoed back as `event.action` on click. */
  action: string;
  title: string;
  icon?: string;
};

/** Tells the service worker what authenticated request to fire when a given
 *  notification action is tapped — keyed by the action id. The fetch is sent
 *  same-origin with `credentials: 'include'`, so the server re-validates the
 *  caller from the session cookie (a spoofed push can't forge it). */
export type WebPushActionRequest = {
  url: string;
  /** Defaults to "POST". */
  method?: string;
  /** JSON-serialized as the request body. */
  body?: unknown;
};

export type WebPushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
  /** Action buttons shown on the notification. */
  actions?: WebPushAction[];
  /** Per-action request the SW fires on tap (action id → request). When an
   *  action has a request, the SW fetches it instead of opening `url`. */
  actionRequests?: Record<string, WebPushActionRequest>;
  /** Unread/pending count to show on the app icon badge (0 clears it). The SW
   *  applies it on receipt, so the badge updates even with no window open. */
  badgeCount?: number;
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
