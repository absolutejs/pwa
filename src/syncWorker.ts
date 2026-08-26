import {
  createIndexedDbSyncLocalStore,
  resolveSyncLocalSchemaComponents,
  runHeadlessSync,
} from "@absolutejs/sync/client";
import type { SyncLocalStoreSchemaBundle } from "@absolutejs/sync/client";

type WorkerSyncConfig = {
  backgroundTag: string;
  databaseName?: string;
  endpoint: string;
  maxAttempts?: number;
  maxMutations?: number;
  maxPulls?: number;
  namespace: string;
  storageSchema?: SyncLocalStoreSchemaBundle;
  version: 1;
};

export type PwaSyncTrigger = "background-sync" | "configure" | "lifecycle";

type ExtendableEventLike = Event & {
  waitUntil(promise: Promise<unknown>): void;
};
type SyncEventLike = ExtendableEventLike & { tag?: string };
type WorkerMessageEvent = MessageEvent<unknown> & ExtendableEventLike;
type WorkerClient = { postMessage(message: unknown): void };
type WorkerScope = {
  addEventListener(type: string, listener: (event: never) => void): void;
  clients: { matchAll(options: unknown): Promise<WorkerClient[]> };
  location: { origin: string };
};

const worker = globalThis as unknown as WorkerScope;
const CONFIG_DATABASE = "absolutejs-pwa-sync-config-v1";
const CONFIG_STORE = "config";
const CONFIG_KEY = "active";
const DEFAULT_TAG = "absolutejs-sync";

const requestResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const transactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

const openConfigDatabase = async () => {
  const request = indexedDB.open(CONFIG_DATABASE, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(CONFIG_STORE)) {
      request.result.createObjectStore(CONFIG_STORE);
    }
  };
  return requestResult(request);
};

const readConfig = async (): Promise<WorkerSyncConfig | undefined> => {
  const database = await openConfigDatabase();
  try {
    const transaction = database.transaction(CONFIG_STORE, "readonly");
    return await requestResult<WorkerSyncConfig | undefined>(
      transaction.objectStore(CONFIG_STORE).get(CONFIG_KEY),
    );
  } finally {
    database.close();
  }
};

const writeConfig = async (config: WorkerSyncConfig | undefined) => {
  const database = await openConfigDatabase();
  try {
    const transaction = database.transaction(CONFIG_STORE, "readwrite");
    const store = transaction.objectStore(CONFIG_STORE);
    if (config) store.put(config, CONFIG_KEY);
    else store.delete(CONFIG_KEY);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
};

const sameOriginUrl = (value: unknown) => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value, worker.location.origin);
    return url.origin === worker.location.origin ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const nonNegativeInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const parseStorageSchema = (
  value: unknown,
): SyncLocalStoreSchemaBundle | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || !("components" in value))
    throw new TypeError("PWA Sync received invalid storage schema metadata.");
  const schema = value as SyncLocalStoreSchemaBundle;
  resolveSyncLocalSchemaComponents({}, schema);
  return schema;
};

const parseConfig = (value: unknown): WorkerSyncConfig | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const endpoint = sameOriginUrl(Reflect.get(value, "endpoint"));
  const namespace = Reflect.get(value, "namespace");
  const backgroundTag = Reflect.get(value, "backgroundTag");
  if (
    !endpoint ||
    typeof namespace !== "string" ||
    namespace.length === 0 ||
    namespace.length > 256 ||
    /\s/u.test(namespace) ||
    (backgroundTag !== undefined &&
      (typeof backgroundTag !== "string" || backgroundTag.length === 0))
  )
    return undefined;

  const databaseName = Reflect.get(value, "databaseName");
  let storageSchema: SyncLocalStoreSchemaBundle | undefined;
  try {
    storageSchema = parseStorageSchema(Reflect.get(value, "storageSchema"));
  } catch {
    return undefined;
  }
  return {
    backgroundTag: backgroundTag ?? DEFAULT_TAG,
    ...(typeof databaseName === "string" && databaseName.length > 0
      ? { databaseName }
      : {}),
    endpoint,
    maxAttempts: nonNegativeInteger(Reflect.get(value, "maxAttempts")),
    maxMutations: nonNegativeInteger(Reflect.get(value, "maxMutations")),
    maxPulls: nonNegativeInteger(Reflect.get(value, "maxPulls")),
    namespace,
    ...(storageSchema ? { storageSchema } : {}),
    version: 1,
  };
};

const notifyClients = async (message: unknown) => {
  const clients = await worker.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  clients.forEach((client) => client.postMessage(message));
};

let activeRun: Promise<void> | undefined;
let activeRunAbort: AbortController | undefined;
let configReplacement = Promise.resolve();
const runConfiguredSync = (trigger: PwaSyncTrigger) => {
  if (activeRun) return activeRun;
  const abort = new AbortController();
  activeRunAbort = abort;
  activeRun = (async () => {
    const config = await readConfig();
    if (!config) return;
    const startedAt = performance.now();
    try {
      const result = await runHeadlessSync({
        endpoint: config.endpoint,
        store: createIndexedDbSyncLocalStore({
          ...(config.databaseName ? { databaseName: config.databaseName } : {}),
          ...(config.storageSchema
            ? { storageSchema: config.storageSchema }
            : {}),
        }),
        namespace: config.namespace,
        maxAttempts: config.maxAttempts,
        maxMutations: config.maxMutations,
        maxPulls: config.maxPulls,
        fetch: async (url, init) => {
          const target = sameOriginUrl(url);
          if (!target)
            throw new Error("PWA Sync refused a cross-origin endpoint.");
          return fetch(target, {
            ...init,
            credentials: "include",
            redirect: "error",
            signal: abort.signal,
          });
        },
      });
      await notifyClients({
        type: "ABSOLUTE_SYNC_RESULT",
        ok: true,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        trigger,
        acknowledged: result.acknowledged,
        conflictsDiscarded: result.conflictsDiscarded,
        conflictsRetried: result.conflictsRetried,
        deadLettered: result.deadLettered,
        pulled: result.pulled,
        retryScheduled: result.retryScheduled,
      });
    } catch {
      await notifyClients({
        type: "ABSOLUTE_SYNC_RESULT",
        ok: false,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        trigger,
      });
      throw new Error("PWA Sync run failed.");
    }
  })().finally(() => {
    activeRun = undefined;
    activeRunAbort = undefined;
  });
  return activeRun;
};

const replaceConfig = async (
  config: WorkerSyncConfig | undefined,
  trigger: PwaSyncTrigger,
) => {
  activeRunAbort?.abort();
  await activeRun?.catch(() => undefined);
  await writeConfig(config);
  if (config) await runConfiguredSync(trigger);
};

const scheduleConfigReplacement = (
  config: WorkerSyncConfig | undefined,
  trigger: PwaSyncTrigger,
) => {
  const replacement = configReplacement.then(() =>
    replaceConfig(config, trigger),
  );
  configReplacement = replacement.catch(() => undefined);
  return replacement;
};

worker.addEventListener("sync", ((event: SyncEventLike) => {
  event.waitUntil(
    configReplacement.then(() =>
      readConfig().then((config) =>
        config && event.tag === config.backgroundTag
          ? runConfiguredSync("background-sync")
          : undefined,
      ),
    ),
  );
}) as never);

worker.addEventListener("message", ((event: WorkerMessageEvent) => {
  if (typeof event.data !== "object" || event.data === null) return;
  const type = Reflect.get(event.data, "type");
  if (type === "ABSOLUTE_SYNC_CONFIGURE") {
    const config = parseConfig(Reflect.get(event.data, "config"));
    event.waitUntil(
      config
        ? scheduleConfigReplacement(config, "configure")
        : Promise.resolve(),
    );
  } else if (type === "ABSOLUTE_SYNC_CLEAR") {
    event.waitUntil(scheduleConfigReplacement(undefined, "lifecycle"));
  } else if (type === "ABSOLUTE_SYNC_RUN") {
    event.waitUntil(
      configReplacement.then(() => runConfiguredSync("lifecycle")),
    );
  }
}) as never);
