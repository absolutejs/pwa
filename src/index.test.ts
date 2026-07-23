import { describe, expect, test } from "bun:test";
import { parseWebPushSubscription } from "./index";

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
