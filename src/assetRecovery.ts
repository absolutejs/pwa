/** A failed lazy navigation must not silently reload and discard a draft.
 * Capture the destination separately from the failed asset and let the host
 * present one explicit retry/update action. Error telemetry remains untouched. */
export type AssetLoadFailure = {
  kind: "navigation" | "resource";
  targetUrl?: string;
  resourceUrl?: string;
  offline: boolean;
};
const listeners = new Set<(failure: AssetLoadFailure | undefined) => void>();
let latest: AssetLoadFailure | undefined;
const importFailure =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading (?:css )?chunk [\w-]+ failed/i;
const sameOrigin = (value: string): string | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    const url = new URL(value, window.location.href);
    return /^https?:$/.test(url.protocol) &&
      url.origin === window.location.origin &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};
const emit = (failure: AssetLoadFailure) => {
  // A late speculative preload failure must not replace the user's intended route.
  if (latest?.kind === "navigation" && failure.kind === "resource") return;
  latest = failure;
  for (const listener of listeners) listener(failure);
};
/** Feed handled router failures here; unrelated application errors return false. */
export const reportAssetLoadFailure = (
  error: unknown,
  targetUrl?: string,
): boolean => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (!importFailure.test(message) || typeof window === "undefined")
    return false;
  const target = targetUrl === undefined ? undefined : sameOrigin(targetUrl);
  if (targetUrl !== undefined && target === undefined) return false;
  emit({
    kind: "navigation",
    ...(target ? { targetUrl: target } : {}),
    offline: typeof navigator !== "undefined" && navigator.onLine === false,
  });
  return true;
};
/** Subscription replays a failure captured before the page's recovery UI mounted. */
export const onAssetLoadFailure = (
  listener: (failure: AssetLoadFailure | undefined) => void,
): (() => void) => {
  listeners.add(listener);
  if (latest) listener(latest);
  return () => {
    listeners.delete(listener);
  };
};
/** Clear after a successful navigation/retry, never just because an update was found. */
export const clearAssetLoadFailure = (): void => {
  latest = undefined;
  for (const listener of listeners) listener(undefined);
};
export const installAssetLoadRecovery = (
  checkForUpdate: () => void,
): (() => void) => {
  if (typeof window === "undefined") return () => {};
  const unsubscribe = onAssetLoadFailure((failure) => {
    if (failure) checkForUpdate();
  });
  const onError = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tag = target.tagName.toLowerCase();
    const rel = target.getAttribute("rel")?.toLowerCase();
    if (
      tag !== "script" &&
      !(tag === "link" && (rel === "modulepreload" || rel === "stylesheet"))
    )
      return;
    const value = target.getAttribute(tag === "script" ? "src" : "href");
    const url = value ? sameOrigin(value) : undefined;
    if (!url) return;
    emit({
      kind: "resource",
      resourceUrl: url,
      offline: typeof navigator !== "undefined" && navigator.onLine === false,
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportAssetLoadFailure(event.reason);
  };
  const onOnline = () => {
    if (latest?.offline) emit({ ...latest, offline: false });
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    unsubscribe();
    window.removeEventListener("online", onOnline);
    window.removeEventListener("error", onError, true);
    window.removeEventListener("unhandledrejection", onRejection);
  };
};
