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
