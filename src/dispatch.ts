import type { WebPushPayload, WebPushSender } from "./index";

type DispatchPushMessage = {
  actions?: ReadonlyArray<{ deepLink?: string; id: string; label: string }>;
  badge?: number;
  body: string;
  data?: Record<string, unknown>;
  deepLink?: string;
  idempotencyKey?: string;
  title?: string;
};

type DispatchWebPushSubscription = {
  platform: "webpush";
  subscription: {
    endpoint: string;
    keys: { auth: string; p256dh: string };
  };
};

type DispatchPushAdapter = {
  name: string;
  send(message: DispatchPushMessage): Promise<{
    at: number;
    provider: string;
  }>;
};

const sendFailure = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

const payloadFor = (message: DispatchPushMessage): WebPushPayload => ({
  actions: message.actions?.map((action) => ({
    action: action.id,
    title: action.label,
  })),
  actionLinks: Object.fromEntries(
    (message.actions ?? []).flatMap((action) =>
      action.deepLink ? [[action.id, action.deepLink]] : [],
    ),
  ),
  ...(message.badge === undefined ? {} : { badgeCount: message.badge }),
  body: message.body,
  data: message.data,
  id: message.idempotencyKey ?? crypto.randomUUID(),
  title: message.title ?? "Notification",
  ...(message.deepLink ? { url: message.deepLink } : {}),
});

/** Bind Dispatch's provider-neutral fanout to one structured browser
 * subscription without flattening its authentication keys into a token. */
export const createWebPushDispatchAdapter = (
  sender: WebPushSender,
  subscription: DispatchWebPushSubscription,
): DispatchPushAdapter => {
  if (subscription.platform !== "webpush")
    throw new TypeError("Web Push adapter requires a webpush subscription.");

  return {
    name: "webpush",
    send: async (message) => {
      const result = await sender.send(
        subscription.subscription,
        payloadFor(message),
      );
      if (result.gone)
        throw sendFailure(410, "Web Push subscription is no longer valid.");
      if (!result.ok)
        throw sendFailure(503, "Web Push provider delivery failed.");

      return { at: Date.now(), provider: "webpush" };
    },
  };
};
