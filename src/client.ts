// @absolutejs/pwa/client — browser glue for service-worker registration and
// Web Push subscription. Decoupled from your API: subscribe/unsubscribe RETURN
// the subscription/endpoint and you POST it to your own server routes. Every
// function is feature-safe — it no-ops when the APIs are missing, so callers
// needn't guard for unsupported browsers or SSR.

const BASE64_GROUP = 4;

const supportsPush = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

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

/** Register the service worker (installability + push delivery). Safe to call on
 *  every boot; a failed registration is swallowed so it never breaks page load. */
export const registerServiceWorker = async (path = "/sw.js") => {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.register(path).catch(() => undefined);
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

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
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

/** Fire `onAvailable` when a new service worker has installed and is waiting to
 *  activate (a new app version is ready). Call once at boot, after
 *  registerServiceWorker. Pair with applyUpdate() to swap + reload. Requires the
 *  SW built WITHOUT `skipWaiting` (the default), so updates wait for consent. */
export const onUpdateAvailable = (onAvailable: () => void) => {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  void navigator.serviceWorker.ready.then((registration) => {
    if (registration.waiting && navigator.serviceWorker.controller) onAvailable();
    registration.addEventListener("updatefound", () => {
      const next = registration.installing;
      if (!next) return;
      next.addEventListener("statechange", () => {
        if (next.state === "installed" && navigator.serviceWorker.controller) {
          onAvailable();
        }
      });
    });
  });
};

/** Activate the waiting worker; the page reloads automatically once it takes
 *  control. Call from the "reload" action of your update prompt. */
export const applyUpdate = async () => {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  registration?.waiting?.postMessage("SKIP_WAITING");
};
