import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  clearAssetLoadFailure,
  installAssetLoadRecovery,
  onAssetLoadFailure,
  reportAssetLoadFailure,
  type AssetLoadFailure,
} from "./assetRecovery";
const saved = new Map<string, PropertyDescriptor | undefined>();
class FakeElement {
  constructor(
    readonly tagName: string,
    readonly attributes: Record<string, string>,
  ) {}
  getAttribute(key: string) {
    return this.attributes[key] ?? null;
  }
}
let browser: EventTarget;
beforeEach(() => {
  for (const key of ["window", "navigator", "Element"])
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  browser = Object.assign(new EventTarget(), {
    location: { href: "https://app.test/intake", origin: "https://app.test" },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: browser,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: true },
  });
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: FakeElement,
  });
  clearAssetLoadFailure();
});
afterEach(() => {
  clearAssetLoadFailure();
  for (const [key, value] of saved) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const resource = (tag: string, attributes: Record<string, string>) => {
  const e = new Event("error");
  Object.defineProperty(e, "target", {
    value: new FakeElement(tag, attributes),
  });
  browser.dispatchEvent(e);
};
test("captured router failure is replayed to late UI without navigating or swallowing unrelated errors", () => {
  expect(reportAssetLoadFailure(new Error("ordinary failure"), "/next")).toBe(
    false,
  );
  expect(
    reportAssetLoadFailure(
      new TypeError("Failed to fetch dynamically imported module"),
      "/next?tab=one",
    ),
  ).toBe(true);
  const failures: AssetLoadFailure[] = [];
  const stop = onAssetLoadFailure((f) => {
    if (f) failures.push(f);
  });
  expect(failures).toEqual([
    {
      kind: "navigation",
      targetUrl: "https://app.test/next?tab=one",
      offline: false,
    },
  ]);
  stop();
});
test("critical same-origin resources trigger checks; tracking pixels, cross-origin files and speculative prefetch do not", () => {
  let checks = 0;
  const failures: AssetLoadFailure[] = [];
  const off = onAssetLoadFailure((f) => {
    if (f) failures.push(f);
  });
  const stop = installAssetLoadRecovery(() => checks++);
  resource("IMG", { src: "/logo.png" });
  resource("SCRIPT", { src: "https://other.test/tracker.js" });
  resource("LINK", { rel: "prefetch", href: "/next.js" });
  expect(checks).toBe(0);
  resource("LINK", { rel: "modulepreload", href: "/chunk-abcdefgh.js" });
  resource("LINK", { rel: "stylesheet", href: "/app.css" });
  expect(checks).toBe(2);
  expect(failures[0]?.resourceUrl).toBe("https://app.test/chunk-abcdefgh.js");
  stop();
  resource("SCRIPT", { src: "/missing.js" });
  expect(checks).toBe(2);
  off();
});
test("a later preload cannot overwrite a failed navigation destination", () => {
  const failures: AssetLoadFailure[] = [];
  const off = onAssetLoadFailure((f) => {
    if (f) failures.push(f);
  });
  const stop = installAssetLoadRecovery(() => {});
  reportAssetLoadFailure("Loading chunk abcd failed", "/partners");
  resource("LINK", { rel: "modulepreload", href: "/chunk-abcdefgh.js" });
  expect(failures).toHaveLength(1);
  expect(failures[0]?.targetUrl).toEndWith("/partners");
  stop();
  off();
});
test("rejects external recovery destinations and retains offline context", () => {
  expect(
    reportAssetLoadFailure(
      "Importing a module script failed",
      "https://evil.test",
    ),
  ).toBe(false);
  expect(
    reportAssetLoadFailure(
      "Importing a module script failed",
      "javascript:alert(1)",
    ),
  ).toBe(false);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: false },
  });
  const failures: AssetLoadFailure[] = [];
  const off = onAssetLoadFailure((f) => {
    if (f) failures.push(f);
  });
  reportAssetLoadFailure("Importing a module script failed", "/next");
  expect(failures[0]?.offline).toBe(true);
  off();
});
test("explicit update uses the intended route once and rejects external URLs", async () => {
  const client = await import(`./client.ts?asset-recovery=${Date.now()}`);
  const navigation: string[] = [];
  Object.assign(browser, {
    location: {
      href: "https://app.test/intake",
      origin: "https://app.test",
      replace: (url: string) => navigation.push(url),
      reload: () => navigation.push("reload"),
    },
  });
  await expect(
    client.applyUpdate({ targetUrl: "https://evil.test" }),
  ).rejects.toThrow("same-origin");
  await Promise.all([
    client.applyUpdate({ targetUrl: "/partners" }),
    client.applyUpdate({ targetUrl: "/partners" }),
  ]);
  expect(navigation).toEqual(["https://app.test/partners"]);
});
