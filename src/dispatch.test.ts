import { describe, expect, test } from "bun:test";
import { createWebPushDispatchAdapter } from "./dispatch";

const subscription = {
  platform: "webpush" as const,
  subscription: {
    endpoint: "https://push.example/subscription-1",
    keys: { auth: "auth-key", p256dh: "p256dh-key" },
  },
};

describe("Dispatch Web Push adapter", () => {
  test("maps provider-neutral messages without flattening credentials", async () => {
    const deliveries: unknown[] = [];
    const adapter = createWebPushDispatchAdapter(
      {
        isConfigured: () => true,
        send: async (credential, payload) => {
          deliveries.push({ credential, payload });
          return { gone: false, ok: true };
        },
        sendMany: async () => ({ gone: [] }),
      },
      subscription,
    );
    const result = await adapter.send({
      actions: [{ deepLink: "/incidents/1", id: "open", label: "Open" }],
      badge: 2,
      body: "Incident opened",
      data: { incidentId: "1" },
      deepLink: "/incidents/1",
      idempotencyKey: "incident-1",
      title: "Production",
    });

    expect(result.provider).toBe("webpush");
    expect(deliveries).toEqual([
      {
        credential: subscription.subscription,
        payload: {
          actionLinks: { open: "/incidents/1" },
          actions: [{ action: "open", title: "Open" }],
          badgeCount: 2,
          body: "Incident opened",
          data: { incidentId: "1" },
          id: "incident-1",
          title: "Production",
          url: "/incidents/1",
        },
      },
    ]);
  });

  test("maps gone and retryable outcomes for lifecycle retirement", async () => {
    const gone = createWebPushDispatchAdapter(
      {
        isConfigured: () => true,
        send: async () => ({ gone: true, ok: false }),
        sendMany: async () => ({ gone: [] }),
      },
      subscription,
    );
    await expect(gone.send({ body: "gone" })).rejects.toMatchObject({
      status: 410,
    });

    const retryable = createWebPushDispatchAdapter(
      {
        isConfigured: () => true,
        send: async () => ({ gone: false, ok: false }),
        sendMany: async () => ({ gone: [] }),
      },
      subscription,
    );
    await expect(retryable.send({ body: "retry" })).rejects.toMatchObject({
      status: 503,
    });
  });
});
