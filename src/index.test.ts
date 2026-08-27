import { describe, expect, test } from "bun:test";
import { parseWebPushSubscription, pushServiceWorker } from "./index";

describe("pushServiceWorker Sync", () => {
  test("bundles the finite runner only when explicitly enabled", () => {
    const disabled = pushServiceWorker();
    const enabled = pushServiceWorker({ sync: true });

    expect(disabled).not.toContain("ABSOLUTE_SYNC_CONFIGURE");
    expect(enabled).toContain("ABSOLUTE_SYNC_CONFIGURE");
    expect(enabled).toContain("ABSOLUTE_SYNC_RUN");
    expect(enabled).toContain("ABSOLUTE_SYNC_RESULT");
    expect(enabled).toContain("durationMs");
    expect(enabled).toContain("background-sync");
    expect(enabled).toContain("AbortController");
    expect(enabled).toContain("absolutejs-pwa-sync-config-v1");
    expect(enabled).not.toContain("Bearer ");
  });

  test("forwards normalized push events without subscription credentials", () => {
    const worker = pushServiceWorker();

    expect(worker).toContain("ABSOLUTE_PUSH_RECEIVED");
    expect(worker).toContain("ABSOLUTE_PUSH_ACTION");
    expect(worker).toContain("actionLinks");
    expect(worker).not.toContain("subscription.endpoint");
    expect(worker).not.toContain("subscription.keys");
  });

  test("rotates subscriptions through the same-origin trusted Auth contract", () => {
    const worker = pushServiceWorker({
      resubscribe: { applicationServerKey: "AQID" },
    });

    expect(worker).toContain("pushsubscriptionchange");
    expect(worker).toContain('PWA_SUBSCRIBE_PATH = "/auth/push"');
    expect(worker).toContain("platform: 'webpush'");
    expect(worker).toContain("installationId");
    expect(worker).toContain("self.location.origin");
    expect(worker).not.toContain("PWA_SUBSCRIBE_URL");
  });

  test("rejects a cross-origin subscription rotation destination", () => {
    expect(() =>
      pushServiceWorker({
        resubscribe: {
          applicationServerKey: "AQID",
          subscribePath: "https://attacker.example/push",
        },
      }),
    ).toThrow("root-relative");
  });
});

describe("parseWebPushSubscription", () => {
  test("normalizes a browser push subscription", () => {
    expect(
      parseWebPushSubscription({
        endpoint: "https://push.example.test/device",
        expirationTime: null,
        keys: { auth: "auth-key", p256dh: "public-key" },
      }),
    ).toEqual({
      endpoint: "https://push.example.test/device",
      keys: { auth: "auth-key", p256dh: "public-key" },
    });
  });

  test.each([
    null,
    {},
    { endpoint: "http://push.example.test/device", keys: {} },
    {
      endpoint: "not a URL",
      keys: { auth: "auth-key", p256dh: "public-key" },
    },
    {
      endpoint: "https://push.example.test/device",
      keys: { auth: "", p256dh: "public-key" },
    },
  ])("rejects malformed or insecure input", (value) => {
    expect(parseWebPushSubscription(value)).toBeNull();
  });
});
