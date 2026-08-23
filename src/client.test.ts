import { describe, expect, test } from "bun:test";
import {
  announceUpdateAvailable,
  applyUpdate,
  checkForUpdate,
  detectEmbeddedBrowser,
  onUpdateAvailable,
  registerServiceWorker,
  type AppUpdate,
  type EmbeddedBrowser,
} from "./client";

const EMBEDDED_BROWSER_CASES = [
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) Mobile/21G93 Safari/604.1 [FBAN/FBIOS;FBAV/570.0.0.54.72;]",
    { app: "facebook", platform: "ios" },
  ],
  [
    "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 [FBAN/FB4A;FBAV/520.0.0.0.1;]",
    { app: "facebook", platform: "android" },
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Instagram 390.0.0.0.1",
    { app: "instagram", platform: "ios" },
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) [FBAN/MessengerForiOS;FBAV/520.0.0.0.1;]",
    { app: "messenger", platform: "ios" },
  ],
] satisfies Array<[string, EmbeddedBrowser]>;

describe("detectEmbeddedBrowser", () => {
  test.each(EMBEDDED_BROWSER_CASES)(
    "identifies the explicit host marker in %s",
    (userAgent, expected) => {
      expect(detectEmbeddedBrowser(userAgent)).toEqual(expected);
    },
  );

  test.each([
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) Version/17.6 Mobile Safari/604.1",
    "Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile Safari/537.36",
    "facebookexternalhit/1.1",
    "",
  ])("does not guess for an ordinary or unknown browser: %s", (userAgent) => {
    expect(detectEmbeddedBrowser(userAgent)).toBeNull();
  });
});

describe("registerServiceWorker", () => {
  const installBrowser = (
    register: ServiceWorkerContainer["register"],
    readyState: DocumentReadyState = "complete",
  ) => {
    const descriptors = {
      document: Object.getOwnPropertyDescriptor(globalThis, "document"),
      navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
      window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    };
    const browserWindow = new EventTarget();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: browserWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { readyState },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { serviceWorker: { register } },
    });

    return {
      dispatchLoad: () => browserWindow.dispatchEvent(new Event("load")),
      restore: () => {
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
          else Object.defineProperty(globalThis, key, descriptor);
        }
      },
    };
  };

  test("defers registration until the page finishes loading", async () => {
    let attempts = 0;
    const browser = installBrowser(async () => {
      attempts += 1;
      return {} as ServiceWorkerRegistration;
    }, "interactive");
    try {
      const registration = registerServiceWorker();
      await Promise.resolve();
      expect(attempts).toBe(0);
      browser.dispatchLoad();
      await registration;
      expect(attempts).toBe(1);
    } finally {
      browser.restore();
    }
  });

  test("retries a transient script-load failure", async () => {
    let attempts = 0;
    const browser = installBrowser(async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Script /sw.js load failed");
      return {} as ServiceWorkerRegistration;
    });
    try {
      await registerServiceWorker("/sw.js", { retryDelayMs: 0 });
      expect(attempts).toBe(2);
    } finally {
      browser.restore();
    }
  });

  test("does not retry a persistent security rejection", async () => {
    let attempts = 0;
    const browser = installBrowser(async () => {
      attempts += 1;
      const error = new Error("scope rejected");
      error.name = "SecurityError";
      throw error;
    });
    try {
      await registerServiceWorker("/sw.js", { retryDelayMs: 0 });
      expect(attempts).toBe(1);
    } finally {
      browser.restore();
    }
  });
});

describe("app update flow", () => {
  test("latches external signals for late subscribers", () => {
    announceUpdateAvailable({
      currentRelease: "old",
      newestRelease: "new",
      source: "release-probe",
    });
    const updates: AppUpdate[] = [];
    const unsubscribe = onUpdateAvailable((update) => updates.push(update));

    expect(updates).toEqual([
      {
        currentRelease: "old",
        newestRelease: "new",
        sources: ["release-probe"],
      },
    ]);
    unsubscribe();
  });

  test("waits for explicit apply before reloading a service-worker update", async () => {
    const descriptors = {
      navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
      window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    };
    const serviceWorker = new EventTarget();
    const registrationEvents = new EventTarget();
    let reloads = 0;
    let updateChecks = 0;
    let skipWaitingMessages = 0;
    const registration = {
      addEventListener:
        registrationEvents.addEventListener.bind(registrationEvents),
      installing: null,
      update: async () => {
        updateChecks += 1;
      },
      waiting: {
        postMessage: (message: string) => {
          expect(message).toBe("SKIP_WAITING");
          skipWaitingMessages += 1;
          serviceWorker.dispatchEvent(new Event("controllerchange"));
        },
      },
    } as unknown as ServiceWorkerRegistration;
    Object.defineProperty(serviceWorker, "controller", {
      value: {},
    });
    Object.defineProperty(serviceWorker, "getRegistration", {
      value: async () => registration,
    });
    Object.defineProperty(serviceWorker, "ready", {
      value: Promise.resolve(registration),
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { serviceWorker },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { reload: () => (reloads += 1) },
        setTimeout,
      },
    });

    try {
      const updates: AppUpdate[] = [];
      const unsubscribe = onUpdateAvailable((update) => updates.push(update));
      await Promise.resolve();
      expect(updates.at(-1)?.sources).toContain("service-worker");

      serviceWorker.dispatchEvent(new Event("controllerchange"));
      expect(reloads).toBe(0);

      await checkForUpdate();
      expect(updateChecks).toBe(1);
      await applyUpdate({ activationTimeoutMs: 50 });
      expect(skipWaitingMessages).toBe(1);
      expect(reloads).toBe(1);
      unsubscribe();
    } finally {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
        else Object.defineProperty(globalThis, key, descriptor);
      }
    }
  });
});
