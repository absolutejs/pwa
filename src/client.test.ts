import { describe, expect, test } from "bun:test";
import { indexedDB as fakeIndexedDb } from "fake-indexeddb";
import {
  announceUpdateAvailable,
  applyUpdate,
  checkForUpdate,
  configurePwaSync,
  configurePwaPush,
  detectEmbeddedBrowser,
  getLastPwaSyncResult,
  onPwaSyncResult,
  onUpdateAvailable,
  registerServiceWorker,
  type AppUpdate,
  type EmbeddedBrowser,
  type PwaSyncRunResult,
} from "./client";
import { pushNotifications } from "@absolutejs/devices";

describe("PWA Web Push provisioning", () => {
  const pushSetting = async (value?: string | null) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = fakeIndexedDb.open("absolutejs-pwa-runtime-v1", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("settings");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string | null>((resolve, reject) => {
        const transaction = database.transaction(
          "settings",
          value === undefined ? "readonly" : "readwrite",
        );
        const store = transaction.objectStore("settings");
        const request =
          value === undefined
            ? store.get("push.installation-id")
            : value === null
              ? store.delete("push.installation-id")
              : store.put(value, "push.installation-id");
        request.onsuccess = () =>
          resolve(
            value === undefined && typeof request.result === "string"
              ? request.result
              : null,
          );
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  };

  const installPushBrowser = (responses: Response[]) => {
    const descriptors = {
      Notification: Object.getOwnPropertyDescriptor(globalThis, "Notification"),
      fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
      indexedDB: Object.getOwnPropertyDescriptor(globalThis, "indexedDB"),
      navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
      window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    };
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    let unsubscribed = 0;
    const subscription = {
      endpoint: "https://push.example/subscription-1",
      toJSON: () => ({
        endpoint: "https://push.example/subscription-1",
        keys: { auth: "auth-key", p256dh: "p256dh-key" },
      }),
      unsubscribe: async () => {
        unsubscribed += 1;
        return true;
      },
    } as unknown as PushSubscription;
    const registration = {
      pushManager: {
        getSubscription: async () => subscription,
        subscribe: async () => subscription,
      },
    } as unknown as ServiceWorkerRegistration;
    const serviceWorker = new EventTarget() as EventTarget &
      Partial<ServiceWorkerContainer>;
    Object.assign(serviceWorker, { ready: Promise.resolve(registration) });
    const browserWindow = new EventTarget() as EventTarget &
      Record<string, unknown>;
    Object.assign(browserWindow, {
      Notification: class {},
      PushManager: class {},
      atob,
      location: { origin: "https://app.example" },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: browserWindow,
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: {
        permission: "granted",
        requestPermission: async () => "granted",
      },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { language: "en-US", serviceWorker },
    });
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: fakeIndexedDb,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (url: string, init: RequestInit) => {
        requests.push({
          body: init.body ? JSON.parse(String(init.body)) : undefined,
          method: init.method ?? "GET",
          url,
        });
        return responses.shift() ?? new Response(null, { status: 500 });
      },
    });

    return {
      dispatch: (data: unknown) =>
        serviceWorker.dispatchEvent(new MessageEvent("message", { data })),
      requests,
      restore: () => {
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
          else Object.defineProperty(globalThis, key, descriptor);
        }
      },
      unsubscribed: () => unsubscribed,
    };
  };

  test("registers through trusted Auth and recovers an account-owned installation", async () => {
    const browser = installPushBrowser([
      Response.json({ code: "installation-ownership" }, { status: 409 }),
      Response.json({ installationId: "web-installation", registered: true }),
      Response.json({ removed: true }),
    ]);
    try {
      await pushSetting("prior-installation");
      expect(await configurePwaPush({ applicationServerKey: "AQID" })).toEqual({
        configured: true,
      });
      await pushNotifications.enable();
      expect(browser.requests.slice(0, 2)).toEqual([
        {
          body: {
            installationId: "prior-installation",
            locale: "en-US",
            platform: "webpush",
            subscription: {
              endpoint: "https://push.example/subscription-1",
              keys: { auth: "auth-key", p256dh: "p256dh-key" },
            },
          },
          method: "POST",
          url: "https://app.example/auth/push",
        },
        expect.objectContaining({
          body: expect.not.objectContaining({
            installationId: expect.anything(),
          }),
        }),
      ]);
      expect(JSON.stringify(browser.requests)).not.toContain('"token"');
      expect(await pushSetting()).toBe("web-installation");

      await pushNotifications.disable();
      expect(browser.requests.at(-1)).toMatchObject({
        body: { installationId: "web-installation" },
        method: "DELETE",
      });
      expect(browser.unsubscribed()).toBe(1);
      expect(await pushSetting()).toBeNull();
    } finally {
      browser.restore();
    }
  });

  test("forwards credential-free receipt and action events", async () => {
    const browser = installPushBrowser([]);
    const received: unknown[] = [];
    const actions: unknown[] = [];
    try {
      await configurePwaPush({ applicationServerKey: "AQID" });
      const removeReceived = await pushNotifications.onReceived((event) =>
        received.push(event),
      );
      const removeAction = await pushNotifications.onAction((event) =>
        actions.push(event),
      );
      const notification = {
        body: "Ready",
        data: { route: "/ready" },
        id: "push-1",
        title: "Deployment",
      };
      browser.dispatch({
        notification,
        type: "ABSOLUTE_PUSH_RECEIVED",
      });
      browser.dispatch({
        action: { actionId: "open", notification },
        type: "ABSOLUTE_PUSH_ACTION",
      });
      expect(received).toEqual([notification]);
      expect(actions).toEqual([{ actionId: "open", notification }]);
      expect(JSON.stringify({ actions, received })).not.toContain("endpoint");
      await removeReceived();
      await removeAction();
    } finally {
      browser.restore();
    }
  });
});

describe("PWA Sync provisioning", () => {
  const installSyncBrowser = (
    response: Response | (() => Response | Promise<Response>),
  ) => {
    const descriptors = {
      document: Object.getOwnPropertyDescriptor(globalThis, "document"),
      fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
      indexedDB: Object.getOwnPropertyDescriptor(globalThis, "indexedDB"),
      navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
      window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    };
    const messages: unknown[] = [];
    const tags: string[] = [];
    const browserWindow = new EventTarget();
    Object.defineProperty(browserWindow, "location", {
      value: { origin: "https://app.example" },
    });
    const browserDocument = new EventTarget();
    Object.defineProperty(browserDocument, "visibilityState", {
      value: "visible",
    });
    const worker = {
      postMessage: (message: unknown) => messages.push(message),
    };
    const registration = {
      active: worker,
      installing: null,
      sync: { register: async (tag: string) => tags.push(tag) },
      waiting: null,
    } as unknown as ServiceWorkerRegistration;
    let fetched: { init?: RequestInit; url?: string } = {};
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: browserWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: browserDocument,
    });
    const serviceWorker = new EventTarget() as EventTarget &
      Partial<ServiceWorkerContainer>;
    Object.assign(serviceWorker, {
      controller: null,
      ready: Promise.resolve(registration),
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        serviceWorker,
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (url: string, init: RequestInit) => {
        fetched = { init, url };
        return typeof response === "function" ? response() : response;
      },
    });
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: fakeIndexedDb,
    });

    return {
      fetched: () => fetched,
      messages,
      postWorkerResult: (data: unknown) =>
        serviceWorker.dispatchEvent(new MessageEvent("message", { data })),
      restore: () => {
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
          else Object.defineProperty(globalThis, key, descriptor);
        }
      },
      tags,
    };
  };

  test("provisions only an opaque namespace and same-origin finite endpoint", async () => {
    const browser = installSyncBrowser(
      Response.json({ namespace: "auth:v1:opaque_namespace", version: 1 }),
    );
    try {
      expect(await configurePwaSync()).toEqual({ configured: true });
      expect(browser.fetched()).toEqual({
        init: expect.objectContaining({
          body: "{}",
          credentials: "include",
          method: "POST",
          redirect: "error",
        }),
        url: "https://app.example/__absolute/sync/principal",
      });
      expect(browser.tags).toContain("absolutejs-sync");
      const serialized = JSON.stringify(browser.messages);
      expect(serialized).toContain("auth:v1:opaque_namespace");
      expect(serialized).toContain(
        "https://app.example/__absolute/sync/background",
      );
      expect(serialized).not.toContain("cookie");
      expect(serialized).not.toContain("token");
      expect(serialized).not.toContain("args");
    } finally {
      browser.restore();
    }
  });

  test("clears worker configuration when the web session is absent", async () => {
    const browser = installSyncBrowser(new Response(null, { status: 401 }));
    try {
      expect(await configurePwaSync()).toEqual({
        configured: false,
        reason: "unauthenticated",
      });
      expect(browser.messages).toContainEqual({ type: "ABSOLUTE_SYNC_CLEAR" });
    } finally {
      browser.restore();
    }
  });

  test("provisions generated schema metadata to foreground and worker Sync", async () => {
    const browser = installSyncBrowser(
      Response.json({ namespace: "principal-a", version: 1 }),
    );
    const storageSchema = {
      components: [
        { id: "@absolutejs/app", version: 1 },
        {
          id: "@absolutejs/tasks-pack",
          migrations: [{ toVersion: 2 }],
          version: 2,
        },
      ],
    };
    try {
      expect(
        await configurePwaSync({
          databaseName: "pwa-schema-forwarding-test",
          storageSchema,
        }),
      ).toEqual({ configured: true });
      expect(browser.messages).toContainEqual({
        config: expect.objectContaining({ storageSchema }),
        type: "ABSOLUTE_SYNC_CONFIGURE",
      });
    } finally {
      browser.restore();
    }
  });

  test("fails closed before replacing one account namespace with another", async () => {
    let namespace = "principal-a";
    const browser = installSyncBrowser(() =>
      Response.json({ namespace, version: 1 }),
    );
    try {
      expect(await configurePwaSync()).toEqual({ configured: true });
      namespace = "principal-b";
      expect(await configurePwaSync()).toEqual({ configured: true });
      expect(browser.messages).toEqual([
        { type: "ABSOLUTE_SYNC_CLEAR" },
        expect.objectContaining({
          config: expect.objectContaining({ namespace: "principal-a" }),
          type: "ABSOLUTE_SYNC_CONFIGURE",
        }),
        { type: "ABSOLUTE_SYNC_CLEAR" },
        expect.objectContaining({
          config: expect.objectContaining({ namespace: "principal-b" }),
          type: "ABSOLUTE_SYNC_CONFIGURE",
        }),
      ]);
    } finally {
      browser.restore();
    }
  });

  test("lets the newest account refresh win when principal requests finish out of order", async () => {
    let resolveFirst!: (response: Response) => void;
    let request = 0;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const browser = installSyncBrowser(() =>
      request++ === 0
        ? firstResponse
        : Response.json({ namespace: "principal-b", version: 1 }),
    );
    try {
      const first = configurePwaSync();
      await Promise.resolve();
      const second = configurePwaSync();
      expect(await second).toEqual({ configured: true });
      resolveFirst(Response.json({ namespace: "principal-a", version: 1 }));
      expect(await first).toEqual({ configured: false, reason: "superseded" });
      expect(browser.messages).toEqual([
        { type: "ABSOLUTE_SYNC_CLEAR" },
        { type: "ABSOLUTE_SYNC_CLEAR" },
        expect.objectContaining({
          config: expect.objectContaining({ namespace: "principal-b" }),
          type: "ABSOLUTE_SYNC_CONFIGURE",
        }),
      ]);
    } finally {
      browser.restore();
    }
  });

  test("publishes only validated aggregate Sync timing and result data", async () => {
    const browser = installSyncBrowser(
      Response.json({ namespace: "principal-a", version: 1 }),
    );
    const results: PwaSyncRunResult[] = [];
    const unsubscribe = onPwaSyncResult((result) => results.push(result));
    try {
      browser.postWorkerResult({
        acknowledged: 2,
        args: { secret: true },
        conflictsDiscarded: 4,
        conflictsRetried: 5,
        deadLettered: 0,
        durationMs: 14,
        namespace: "principal-a",
        ok: true,
        pulled: 3,
        retryScheduled: 1,
        token: "secret",
        trigger: "configure",
        type: "ABSOLUTE_SYNC_RESULT",
      });
      expect(results).toEqual([
        {
          acknowledged: 2,
          conflictsDiscarded: 4,
          conflictsRetried: 5,
          deadLettered: 0,
          durationMs: 14,
          ok: true,
          pulled: 3,
          retryScheduled: 1,
          trigger: "configure",
        },
      ]);
      expect(getLastPwaSyncResult()).toEqual(results[0]);
      expect(JSON.stringify(results)).not.toContain("principal-a");
      expect(JSON.stringify(results)).not.toContain("secret");

      browser.postWorkerResult({
        durationMs: -1,
        ok: true,
        trigger: "configure",
        type: "ABSOLUTE_SYNC_RESULT",
      });
      expect(results).toHaveLength(1);
    } finally {
      unsubscribe();
      browser.restore();
    }
  });

  test("refuses cross-origin endpoints before the principal request", async () => {
    const browser = installSyncBrowser(
      Response.json({ namespace: "auth:v1:opaque_namespace", version: 1 }),
    );
    try {
      await expect(
        configurePwaSync({ endpoint: "https://attacker.example/sync" }),
      ).rejects.toThrow("exact same-origin");
      expect(browser.fetched().url).toBeUndefined();
    } finally {
      browser.restore();
    }
  });
});

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

describe("long-lived tab update checks", () => {
  test("probes releases on reconnect, tolerates offline/invalid responses, latches once and cleans up", async () => {
    const { startAppUpdateChecks } = await import("./client");
    const originals = ["window", "document", "navigator"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    );
    let tick = () => {};
    let requests = 0;
    let cleared = false;
    let value: unknown = { release: "a" };
    let offline = false;
    const win = Object.assign(new EventTarget(), {
      location: { href: "https://example.com/", origin: "https://example.com" },
      fetch: async (_url: string, options: RequestInit) => {
        requests++;
        expect(options.cache).toBe("no-store");
        if (offline) throw Error("offline");
        return Response.json(value);
      },
      setTimeout,
      clearTimeout,
      setInterval: (callback: () => void) => {
        tick = callback;
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      },
    });
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible",
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: win,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: doc,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    const updates: AppUpdate[] = [];
    const unsubscribe = onUpdateAvailable((update) => updates.push(update));
    updates.length = 0;
    const stop = startAppUpdateChecks({ currentRelease: "a" });
    try {
      await Bun.sleep(5);
      expect(updates).toHaveLength(0);
      offline = true;
      win.dispatchEvent(new Event("online"));
      await Bun.sleep(5);
      expect(updates).toHaveLength(0);
      offline = false;
      value = { release: null };
      tick();
      await Bun.sleep(5);
      expect(updates).toHaveLength(0);
      value = { commit: "b" };
      doc.visibilityState = "hidden";
      tick();
      await Bun.sleep(5);
      expect(updates).toHaveLength(0);
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      await Bun.sleep(5);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.newestRelease).toBe("b");
      tick();
      win.dispatchEvent(new Event("focus"));
      await Bun.sleep(5);
      expect(updates).toHaveLength(1);
      stop();
      const previous = requests;
      win.dispatchEvent(new Event("online"));
      tick();
      await Bun.sleep(5);
      expect(requests).toBe(previous);
      expect(cleared).toBe(true);
    } finally {
      stop();
      unsubscribe();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});

test("a denied update lookup can be retried without duplicate reloads", async () => {
  const specifier = "./client.ts?retry-update-test";
  const { applyUpdate: applyFreshUpdate } = await import(specifier);
  const originals = ["window", "navigator"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  let attempts = 0,
    reloads = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { reload: () => reloads++ } },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        getRegistration: async () => {
          if (++attempts === 1) throw Error("temporarily denied");
          return undefined;
        },
      },
    },
  });
  try {
    await expect(applyFreshUpdate()).rejects.toThrow("temporarily denied");
    await Promise.all([applyFreshUpdate(), applyFreshUpdate()]);
    expect(attempts).toBe(2);
    expect(reloads).toBe(1);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

describe("automatic updates at a safe moment", () => {
  let freshModule = 0;
  const installPage = () => {
    const originals = ["window", "document", "navigator"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    );
    const state = {
      reloads: 0,
      dialogOpen: false,
      focused: null as null | { matches: (selector: string) => boolean },
    };
    const win = Object.assign(new EventTarget(), {
      location: {
        href: "https://example.com/tasks?task=1",
        origin: "https://example.com",
        reload: () => {
          state.reloads++;
        },
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible" as "visible" | "hidden",
      querySelector: () => (state.dialogOpen ? {} : null),
      get activeElement() {
        return state.focused;
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: win,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: doc,
    });
    // No service worker: applyUpdate falls back to a plain reload.
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    const restore = () => {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    return { win, doc, state, restore };
  };
  const load = async () =>
    (await import(
      `./client.ts?auto-update-${++freshModule}`
    )) as typeof import("./client");
  const announce = (client: typeof import("./client")) =>
    client.announceUpdateAvailable({
      source: "release-probe",
      newestRelease: "b",
    });

  test("a hidden tab updates as soon as the new release is known", async () => {
    const page = installPage();
    const client = await load();
    page.doc.visibilityState = "hidden";
    const stop = client.startAutoUpdate({ idleMs: 60_000 });
    try {
      await Bun.sleep(5);
      expect(page.state.reloads).toBe(0);
      announce(client);
      await Bun.sleep(20);
      expect(page.state.reloads).toBe(1);
    } finally {
      stop();
      page.restore();
    }
  });

  test("a visible tab waits for a quiet period, and new input restarts it", async () => {
    const page = installPage();
    const client = await load();
    const stop = client.startAutoUpdate({ idleMs: 80 });
    try {
      announce(client);
      await Bun.sleep(50);
      page.win.dispatchEvent(new Event("keydown"));
      await Bun.sleep(50);
      expect(page.state.reloads).toBe(0);
      await Bun.sleep(80);
      expect(page.state.reloads).toBe(1);
    } finally {
      stop();
      page.restore();
    }
  });

  test("open dialogs, focused fields and the app's own veto postpone the update", async () => {
    const page = installPage();
    const client = await load();
    let unsaved = true;
    let crashing = false;
    const stop = client.startAutoUpdate({
      idleMs: 0,
      retryMs: 20,
      isBusy: () => {
        if (crashing) throw Error("check failed");
        return unsaved;
      },
    });
    try {
      page.state.dialogOpen = true;
      announce(client);
      await Bun.sleep(40);
      expect(page.state.reloads).toBe(0);
      page.state.dialogOpen = false;
      page.state.focused = { matches: () => true };
      await Bun.sleep(40);
      expect(page.state.reloads).toBe(0);
      page.state.focused = null;
      await Bun.sleep(40);
      expect(page.state.reloads).toBe(0); // isBusy() still true
      unsaved = false;
      crashing = true;
      await Bun.sleep(40);
      expect(page.state.reloads).toBe(0); // a failing check never forces a reload
      crashing = false;
      await Bun.sleep(40);
      expect(page.state.reloads).toBe(1);
    } finally {
      stop();
      page.restore();
    }
  });

  test("stopping cancels a pending automatic update", async () => {
    const page = installPage();
    const client = await load();
    const stop = client.startAutoUpdate({ idleMs: 40 });
    announce(client);
    stop();
    try {
      await Bun.sleep(80);
      expect(page.state.reloads).toBe(0);
    } finally {
      page.restore();
    }
  });
});
