// @absolutejs/pwa/client — browser glue for service-worker registration and
// Web Push subscription. Decoupled from your API: subscribe/unsubscribe RETURN
// the subscription/endpoint and you POST it to your own server routes. Every
// function is feature-safe — it no-ops when the APIs are missing, so callers
// needn't guard for unsupported browsers or SSR.

import type { SyncRuntimeClient } from "@absolutejs/sync/client";

const BASE64_GROUP = 4;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;

export type EmbeddedBrowserApp = "facebook" | "instagram" | "messenger";
export type EmbeddedBrowserPlatform = "android" | "ios" | "unknown";

export type EmbeddedBrowser = {
  app: EmbeddedBrowserApp;
  platform: EmbeddedBrowserPlatform;
};

const currentUserAgent = () =>
  typeof navigator === "undefined" ? "" : navigator.userAgent;

/** Identify common social-app embedded browsers from their explicit host-app
 *  user-agent markers. Returns null for ordinary browsers and unknown hosts so
 *  callers do not degrade UX based on a broad mobile-WebKit guess. */
export const detectEmbeddedBrowser = (
  userAgent = currentUserAgent(),
): EmbeddedBrowser | null => {
  const platform: EmbeddedBrowserPlatform = /android/i.test(userAgent)
    ? "android"
    : /iphone|ipad|ipod/i.test(userAgent)
      ? "ios"
      : "unknown";

  if (/instagram/i.test(userAgent)) return { app: "instagram", platform };
  if (
    /FBAN\/MessengerForiOS|FBAN\/MESSENGER|\bMessengerForAndroid\b/i.test(
      userAgent,
    )
  ) {
    return { app: "messenger", platform };
  }
  if (/\[FBAN\/(?:FBIOS|FB4A);|\bFB_IAB\/FB4A\b/i.test(userAgent)) {
    return { app: "facebook", platform };
  }

  return null;
};

export type BrowserCapabilities = {
  clipboardWrite: boolean;
  embeddedBrowser: EmbeddedBrowser | null;
  installPrompt: boolean;
  mediaCapture: boolean;
  passkeys: boolean;
  pushNotifications: boolean;
  serviceWorker: boolean;
  webShare: boolean;
};

/** Snapshot browser capabilities for action-level UX. Feature checks remain the
 *  source of truth; embedded-browser identity is context for explaining why a
 *  capability is unavailable, never a substitute for a feature check. */
export const getBrowserCapabilities = (): BrowserCapabilities => {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {
      clipboardWrite: false,
      embeddedBrowser: null,
      installPrompt: false,
      mediaCapture: false,
      passkeys: false,
      pushNotifications: false,
      serviceWorker: false,
      webShare: false,
    };
  }

  const serviceWorker = "serviceWorker" in navigator;

  return {
    clipboardWrite: typeof navigator.clipboard?.writeText === "function",
    embeddedBrowser: detectEmbeddedBrowser(),
    installPrompt: deferredPrompt !== null,
    mediaCapture: typeof navigator.mediaDevices?.getUserMedia === "function",
    passkeys: "PublicKeyCredential" in window,
    pushNotifications:
      serviceWorker && "PushManager" in window && "Notification" in window,
    serviceWorker,
    webShare: typeof navigator.share === "function",
  };
};

const supportsPush = () => getBrowserCapabilities().pushNotifications;

// VAPID public key (base64url) → the Uint8Array applicationServerKey expects.
const urlBase64ToUint8Array = (base64: string) => {
  const padLength =
    (BASE64_GROUP - (base64.length % BASE64_GROUP)) % BASE64_GROUP;
  const normalized = (base64 + "=".repeat(padLength))
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  const raw = window.atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }

  return output;
};

export type PwaSyncOptions = {
  /** Finite Sync JSON endpoint. Must resolve to this page's exact origin. */
  endpoint?: string;
  /** Auth namespace bootstrap. Must resolve to this page's exact origin. */
  principalEndpoint?: string;
  /** Shared IndexedDB name used by foreground clients and the worker. */
  databaseName?: string;
  /** Browser Background Sync tag. Default `absolutejs-sync`. */
  backgroundTag?: string;
  maxAttempts?: number;
  maxMutations?: number;
  maxPulls?: number;
};

export type ServiceWorkerRegistrationRetryOptions = {
  /** Wait for the document load event before competing for the network. Default
   *  true. */
  deferUntilLoad?: boolean;
  /** Total registration attempts for transient browser/network failures.
   *  Default 3. */
  maxAttempts?: number;
  /** Initial retry delay. Later retries use exponential backoff. Default
   *  1000ms. */
  retryDelayMs?: number;
  /** Provision cookie-authenticated finite Sync after registration. The served
   *  worker must have been generated with `pushServiceWorker({ sync: true })`. */
  sync?: false | PwaSyncOptions;
};

const TRANSIENT_SERVICE_WORKER_ERRORS = new Set([
  "AbortError",
  "NetworkError",
  "TimeoutError",
  "TypeError",
]);

const waitForDocumentLoad = async (): Promise<void> => {
  if (typeof document === "undefined" || document.readyState === "complete")
    return;

  await new Promise<void>((resolve) => {
    window.addEventListener("load", () => resolve(), { once: true });
  });
};

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "";

/** Register the service worker (installability + push delivery). Safe to call on
 *  every boot. Registration waits for page load by default and retries transient
 *  browser/network failures; terminal failures are swallowed so they never break
 *  page load. */
export const registerServiceWorker = async (
  path = "/sw.js",
  options: ServiceWorkerRegistrationRetryOptions = {},
) => {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (options.deferUntilLoad !== false) await waitForDocumentLoad();

  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 3));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1000);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let registration: ServiceWorkerRegistration;
    try {
      registration = await navigator.serviceWorker.register(path);
    } catch (error) {
      const mayRetry =
        attempt + 1 < maxAttempts &&
        TRANSIENT_SERVICE_WORKER_ERRORS.has(errorName(error));
      if (!mayRetry) return;
      await new Promise((resolve) =>
        setTimeout(resolve, retryDelayMs * 2 ** attempt),
      );
      continue;
    }
    if (options.sync !== false && options.sync !== undefined) {
      try {
        await configurePwaSync(options.sync, registration);
      } catch {
        // PWA Sync provisioning must not turn a valid SW registration into a
        // page-load failure; explicit configurePwaSync callers can observe it.
      }
    }
    return registration;
  }
};

export type PwaSyncConfigurationResult = {
  configured: boolean;
  reason?: "invalid-principal" | "unauthenticated" | "unsupported";
};

const DEFAULT_SYNC_ENDPOINT = "/__absolute/sync/background";
const DEFAULT_PRINCIPAL_ENDPOINT = "/__absolute/sync/principal";
const DEFAULT_BACKGROUND_TAG = "absolutejs-sync";
const syncClients = new Set<SyncRuntimeClient>();
let uninstallSyncTransport: (() => void) | undefined;
let removeSyncLifecycle: (() => void) | undefined;

const exactOriginUrl = (value: string) => {
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin) {
    throw new TypeError("PWA Sync endpoints must be exact same-origin URLs.");
  }
  return url.href;
};

const postSyncMessage = (
  registration: ServiceWorkerRegistration,
  message: unknown,
) => {
  const workers = new Set([
    registration.active,
    registration.waiting,
    registration.installing,
    navigator.serviceWorker.controller,
  ]);
  workers.forEach((worker) => worker?.postMessage(message));
};

const registerBackgroundSync = async (
  registration: ServiceWorkerRegistration,
  tag: string,
) => {
  const manager = Reflect.get(registration, "sync");
  if (typeof manager !== "object" || manager === null) return;
  const register = Reflect.get(manager, "register");
  if (typeof register !== "function") return;
  try {
    await Reflect.apply(register, manager, [tag]);
  } catch {
    // Background Sync is best-effort (permission and browser support vary).
  }
};

const installPwaSyncLifecycle = (
  registration: ServiceWorkerRegistration,
  backgroundTag: string,
) => {
  removeSyncLifecycle?.();
  const run = () => {
    postSyncMessage(registration, { type: "ABSOLUTE_SYNC_RUN" });
    void registerBackgroundSync(registration, backgroundTag);
    syncClients.forEach((client) => {
      client.reconnect();
      void client.flush().catch(() => undefined);
    });
  };
  const visible = () => {
    if (document.visibilityState === "visible") run();
  };
  window.addEventListener("online", run);
  window.addEventListener("focus", run);
  document.addEventListener("visibilitychange", visible);
  removeSyncLifecycle = () => {
    window.removeEventListener("online", run);
    window.removeEventListener("focus", run);
    document.removeEventListener("visibilitychange", visible);
  };
  return run;
};

/** Provision the shared foreground/worker Sync transport from the active Auth
 * session. The bootstrap returns only an opaque namespace; cookies, tokens,
 * mutation args, and row data are never sent through service-worker messages. */
export const configurePwaSync = async (
  options: PwaSyncOptions = {},
  suppliedRegistration?: ServiceWorkerRegistration,
): Promise<PwaSyncConfigurationResult> => {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  )
    return { configured: false, reason: "unsupported" };

  const registration =
    suppliedRegistration ?? (await navigator.serviceWorker.ready);
  const endpoint = exactOriginUrl(options.endpoint ?? DEFAULT_SYNC_ENDPOINT);
  const principalEndpoint = exactOriginUrl(
    options.principalEndpoint ?? DEFAULT_PRINCIPAL_ENDPOINT,
  );
  const response = await fetch(principalEndpoint, {
    body: "{}",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    method: "POST",
    redirect: "error",
  });
  if (response.status === 401 || response.status === 403) {
    uninstallSyncTransport?.();
    uninstallSyncTransport = undefined;
    removeSyncLifecycle?.();
    removeSyncLifecycle = undefined;
    postSyncMessage(registration, { type: "ABSOLUTE_SYNC_CLEAR" });
    return { configured: false, reason: "unauthenticated" };
  }
  if (!response.ok) return { configured: false, reason: "invalid-principal" };

  const principal: unknown = await response.json();
  const namespace =
    typeof principal === "object" && principal !== null
      ? Reflect.get(principal, "namespace")
      : undefined;
  if (
    typeof namespace !== "string" ||
    namespace.length === 0 ||
    namespace.length > 256 ||
    /\s/u.test(namespace)
  )
    return { configured: false, reason: "invalid-principal" };

  const backgroundTag = options.backgroundTag ?? DEFAULT_BACKGROUND_TAG;
  const { createIndexedDbSyncLocalStore, installSyncClientRuntimeTransport } =
    await import("@absolutejs/sync/client");
  const store = createIndexedDbSyncLocalStore({
    ...(options.databaseName ? { databaseName: options.databaseName } : {}),
  });
  uninstallSyncTransport?.();
  uninstallSyncTransport = installSyncClientRuntimeTransport({
    durable: { namespace, store },
    registerClient: (client) => {
      syncClients.add(client);
      return () => syncClients.delete(client);
    },
  });
  postSyncMessage(registration, {
    type: "ABSOLUTE_SYNC_CONFIGURE",
    config: {
      backgroundTag,
      ...(options.databaseName ? { databaseName: options.databaseName } : {}),
      endpoint,
      maxAttempts: options.maxAttempts,
      maxMutations: options.maxMutations,
      maxPulls: options.maxPulls,
      namespace,
      version: 1,
    },
  });
  const run = installPwaSyncLifecycle(registration, backgroundTag);
  run();

  return { configured: true };
};

export type PushStatus = {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
};

/** Whether push is supported here, the notification permission, and whether this
 *  device currently holds a push subscription. */
export const getPushStatus = async (): Promise<PushStatus> => {
  if (!supportsPush()) {
    return { permission: "unsupported", subscribed: false, supported: false };
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();

  return {
    permission: Notification.permission,
    subscribed: subscription !== null,
    supported: true,
  };
};

/** Request permission (if needed) and subscribe this device with your VAPID
 *  public key. Returns the subscription JSON to POST to your server, or null if
 *  unsupported. Throws `Error("notification-permission-denied")` on a hard deny
 *  so the UI can message it. */
export const subscribeToPush = async (
  vapidPublicKey: string,
): Promise<PushSubscriptionJSON | null> => {
  if (!supportsPush()) return null;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("notification-permission-denied");
  }

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      userVisibleOnly: true,
    }));

  return subscription.toJSON();
};

/** Unsubscribe this device locally. Returns the endpoint that was removed (POST
 *  it to your server to drop the row), or null if there was none. */
export const unsubscribeFromPush = async (): Promise<string | null> => {
  if (!supportsPush()) return null;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return null;

  const { endpoint } = subscription;
  await subscription.unsubscribe();

  return endpoint;
};

// ── Install prompt ───────────────────────────────────────────────────────────

const installListeners = new Set<(installable: boolean) => void>();
const notifyInstallable = (installable: boolean) => {
  installListeners.forEach((listener) => listener(installable));
};

export type InstallPromptOptions = {
  /** Suppress the browser's own install UI (mobile mini-infobar) by deferring
   *  the event. NOTE: Chrome logs a "Banner not shown" notice on every load when
   *  this is set, and modern Chrome no longer shows the mini-infobar anyway —
   *  so it defaults to false. The stashed event stays promptable either way. */
  suppressBrowserPrompt?: boolean;
};

/** Start listening for the browser's install signal. Call once at boot. The
 *  browser fires `beforeinstallprompt` only when the app is installable and not
 *  already installed — we stash it so a custom button can call promptInstall().
 *  By default we do NOT call preventDefault() (see {@link InstallPromptOptions}). */
export const initInstallPrompt = (options: InstallPromptOptions = {}) => {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (event) => {
    if (options.suppressBrowserPrompt) event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notifyInstallable(true);
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notifyInstallable(false);
  });
};

/** Whether a deferred install prompt is currently available. */
export const canInstall = () => deferredPrompt !== null;

/** Subscribe to installability changes (true when a prompt becomes available,
 *  false once used or after install). Returns an unsubscribe fn. */
export const onInstallable = (listener: (installable: boolean) => void) => {
  installListeners.add(listener);

  return () => installListeners.delete(listener);
};

/** Show the native install prompt (must be called from a user gesture). Returns
 *  true if the user accepted. No-ops to false when no prompt is pending. */
export const promptInstall = async (): Promise<boolean> => {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  notifyInstallable(false);

  return choice.outcome === "accepted";
};

// ── App icon badge ────────────────────────────────────────────────────────────

/** Set the installed-app icon badge to `count` (0 or omitted clears it). No-op
 *  where the Badging API is unavailable (most non-installed contexts). */
export const setAppBadge = (count?: number) => {
  if (typeof navigator === "undefined" || !("setAppBadge" in navigator)) return;
  if (count && count > 0) {
    void navigator.setAppBadge(count).catch(() => undefined);
  } else {
    void navigator.clearAppBadge().catch(() => undefined);
  }
};

/** Clear the app icon badge. */
export const clearAppBadge = () => setAppBadge(0);

// ── App update flow ───────────────────────────────────────────────────────────

export type AppUpdateSource = "release-probe" | "service-worker";

export type AppUpdate = {
  currentRelease?: string;
  newestRelease?: string;
  sources: readonly AppUpdateSource[];
};

export type AppUpdateSignal = {
  currentRelease?: string;
  newestRelease?: string;
  source: AppUpdateSource;
};

export type ApplyUpdateOptions = {
  /** Maximum wait for a waiting service worker to take control before a hard
   *  reload. Default 5000ms. */
  activationTimeoutMs?: number;
};

const updateListeners = new Set<(update: AppUpdate) => void>();
const updateSources = new Set<AppUpdateSource>();
let currentRelease: string | undefined;
let newestRelease: string | undefined;
let observingServiceWorker = false;
let applyingUpdate: Promise<void> | undefined;

const updateSnapshot = (): AppUpdate => ({
  ...(currentRelease === undefined ? {} : { currentRelease }),
  ...(newestRelease === undefined ? {} : { newestRelease }),
  sources: [...updateSources],
});

/** Latch an app update discovered outside the service-worker lifecycle, such as
 *  a stale-release probe. Late subscribers are notified immediately, so boot
 *  order cannot lose the prompt. Repeated signals update the same state rather
 *  than scheduling reloads. */
export const announceUpdateAvailable = (signal: AppUpdateSignal): void => {
  updateSources.add(signal.source);
  currentRelease = signal.currentRelease ?? currentRelease;
  newestRelease = signal.newestRelease ?? newestRelease;
  const update = updateSnapshot();
  updateListeners.forEach((listener) => listener(update));
};

const observeServiceWorkerUpdates = (): void => {
  if (
    observingServiceWorker ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  )
    return;
  observingServiceWorker = true;
  void navigator.serviceWorker.ready.then((registration) => {
    if (registration.waiting && navigator.serviceWorker.controller) {
      announceUpdateAvailable({ source: "service-worker" });
    }
    registration.addEventListener("updatefound", () => {
      const next = registration.installing;
      if (!next) return;
      next.addEventListener("statechange", () => {
        if (next.state === "installed" && navigator.serviceWorker.controller) {
          announceUpdateAvailable({ source: "service-worker" });
        }
      });
    });
  });
};

/** Fire `onAvailable` when a new app version is available from either a waiting
 *  service worker or announceUpdateAvailable(). The update state is latched, so
 *  subscribing after detection still displays the prompt. Returns an
 *  unsubscribe function. Passive detection never reloads the page. */
export const onUpdateAvailable = (
  onAvailable: (update: AppUpdate) => void,
): (() => void) => {
  updateListeners.add(onAvailable);
  observeServiceWorkerUpdates();
  if (updateSources.size > 0) onAvailable(updateSnapshot());

  return () => updateListeners.delete(onAvailable);
};

/** Ask the current service-worker registration to check for a newer script.
 *  Safe for focus/visibility polling and a no-op outside a browser. */
export const checkForUpdate = async (): Promise<void> => {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return;
  const registration = await navigator.serviceWorker.getRegistration();
  await registration?.update();
};

/** Apply the update after an explicit user action. A waiting worker is asked to
 *  activate; the page reloads once it takes control, with a bounded hard-reload
 *  fallback. Release-probe-only updates reload immediately. Concurrent calls
 *  share one operation, preventing reload loops from repeated clicks/signals. */
export const applyUpdate = (
  options: ApplyUpdateOptions = {},
): Promise<void> => {
  if (applyingUpdate !== undefined) return applyingUpdate;
  applyingUpdate = (async () => {
    if (typeof window === "undefined") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      window.location.reload();
      return;
    }

    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.waiting) {
      window.location.reload();
      return;
    }

    await new Promise<void>((resolve) => {
      let reloaded = false;
      const reload = () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
        resolve();
      };
      navigator.serviceWorker.addEventListener("controllerchange", reload, {
        once: true,
      });
      window.setTimeout(
        reload,
        Math.max(0, options.activationTimeoutMs ?? 5000),
      );
      registration.waiting?.postMessage("SKIP_WAITING");
    });
  })();

  return applyingUpdate;
};
