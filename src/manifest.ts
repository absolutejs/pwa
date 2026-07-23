import { defineManifest, toolFactory } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type {
  ServiceWorkerOptions,
  WebAppManifestConfig,
  WebPushConfig,
  WebPushSender,
} from "./index";

const tool = toolFactory<WebPushSender>();

/* The package is three independent factories (web-app manifest, service
 * worker, VAPID push sender), so TConfig is the v1 composite convention: one
 * key per factory's real options type. VAPID keys are secret material → env
 * at wiring time, never settings. */
type PwaConfig = {
  appManifest?: WebAppManifestConfig;
  serviceWorker?: ServiceWorkerOptions;
  webPush?: Partial<WebPushConfig>;
};

const iconSchema = Type.Object(
  {
    purpose: Type.Optional(
      Type.String({
        description:
          'How the OS may use the icon: "any", "maskable", or "monochrome".',
        title: "Purpose",
      }),
    ),
    sizes: Type.String({
      description: 'Icon dimensions, e.g. "512x512".',
      title: "Sizes",
    }),
    src: Type.String({
      description: "URL of the icon image.",
      title: "Image URL",
    }),
    type: Type.String({
      description: 'Image MIME type, e.g. "image/png".',
      title: "MIME type",
    }),
  },
  { title: "Icon" },
);

export const manifest = defineManifest<PwaConfig, WebPushSender>()({
  contract: 2,
  identity: {
    accent: "#6366f1",
    category: "growth",
    description:
      "Framework-agnostic PWA + Web Push primitives: a spec-shaped web app manifest, a push service worker (notifications, action buttons, offline app shell with stale-while-revalidate assets, subscription auto-recovery), a VAPID Web Push sender that flags dead endpoints for pruning, and browser glue for registration, subscription, and install prompts (`@absolutejs/pwa/client`). Storage-agnostic — you decide where subscriptions live.",
    docsUrl: "https://github.com/absolutejs/pwa",
    name: "@absolutejs/pwa",
    tagline: "Make your site installable and send push notifications.",
  },
  requires: {
    env: [
      {
        description:
          "VAPID public key for Web Push (generate once with `npx web-push generate-vapid-keys`). Without keys, push no-ops gracefully.",
        docsUrl: "https://github.com/web-push-libs/web-push#command-line",
        example: "BNcRd...base64url",
        key: "VAPID_PUBLIC_KEY",
        optional: true,
      },
      {
        description:
          "VAPID private key for Web Push — the pair of VAPID_PUBLIC_KEY.",
        docsUrl: "https://github.com/web-push-libs/web-push#command-line",
        example: "base64url-private-key",
        key: "VAPID_PRIVATE_KEY",
        optional: true,
        secret: true,
      },
    ],
  },
  settings: Type.Object({
    appManifest: Type.Optional(
      Type.Object(
        {
          backgroundColor: Type.Optional(
            Type.String({
              description:
                "Splash-screen background color while the app loads.",
              examples: ["#ffffff"],
              title: "Background color",
            }),
          ),
          description: Type.Optional(
            Type.String({
              description: "One sentence about the app, shown by app stores and install prompts.",
              title: "App description",
            }),
          ),
          display: Type.Optional(
            Type.Union(
              [
                Type.Literal("standalone"),
                Type.Literal("fullscreen"),
                Type.Literal("minimal-ui"),
                Type.Literal("browser"),
              ],
              {
                description:
                  "How the installed app is framed: standalone (its own window, the usual choice), fullscreen, minimal-ui, or browser.",
                title: "Display mode",
              },
            ),
          ),
          icons: Type.Array(iconSchema, {
            description:
              "App icons — include at least 192x192 and 512x512 PNGs.",
            title: "Icons",
          }),
          name: Type.String({
            description: "Full app name shown on install and splash screens.",
            title: "App name",
          }),
          scope: Type.Optional(
            Type.String({
              description:
                "URL scope the installed app controls (default /).",
              title: "Scope",
            }),
          ),
          shortName: Type.String({
            description:
              "Short name shown under the icon on the home screen.",
            title: "Short name",
          }),
          startUrl: Type.Optional(
            Type.String({
              description:
                "Page the app opens on when launched from the icon (default /).",
              title: "Start URL",
            }),
          ),
          themeColor: Type.Optional(
            Type.String({
              description: "Browser-chrome accent color for the app.",
              examples: ["#6366f1"],
              title: "Theme color",
            }),
          ),
        },
        { title: "Web app manifest" },
      ),
    ),
    serviceWorker: Type.Optional(
      Type.Object(
        {
          badge: Type.Optional(
            Type.String({
              description:
                "Small monochrome icon shown in the status bar for notifications (defaults to the icon).",
              title: "Badge image URL",
            }),
          ),
          icon: Type.Optional(
            Type.String({
              description: "Default image shown on push notifications.",
              title: "Notification icon URL",
            }),
          ),
          offline: Type.Optional(
            Type.Object(
              {
                assetPrefix: Type.Optional(
                  Type.String({
                    description:
                      "Same-origin path prefix served from cache instantly and refreshed in the background.",
                    examples: ["/assets/"],
                    title: "Asset path prefix",
                  }),
                ),
                cacheName: Type.Optional(
                  Type.String({
                    description:
                      "Cache bucket name — change it to throw away old caches.",
                    title: "Cache name",
                  }),
                ),
                fallback: Type.String({
                  description:
                    "Page served when the visitor navigates while offline.",
                  examples: ["/offline.html"],
                  title: "Offline fallback page",
                }),
                precache: Type.Optional(
                  Type.Array(Type.String(), {
                    description:
                      "Extra same-origin URLs cached at install time.",
                    title: "Precache URLs",
                  }),
                ),
              },
              { title: "Offline support" },
            ),
          ),
          skipWaiting: Type.Optional(
            Type.Boolean({
              description:
                "Activate a new service worker immediately instead of waiting for a reload prompt.",
              title: "Activate updates immediately",
            }),
          ),
        },
        { title: "Service worker" },
      ),
    ),
    webPush: Type.Optional(
      Type.Object(
        {
          subject: Type.Optional(
            Type.String({
              description:
                "A mailto: address or URL identifying your server to the browser push services.",
              examples: ["mailto:you@yoursite.com"],
              title: "Push contact",
            }),
          ),
        },
        { title: "Web Push" },
      ),
    ),
  }),
  tools: {
    push_status: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "owner",
        effects: ["read"],
        requiredScopes: ["pwa:push:read"],
      },
      description:
        "Whether Web Push is configured (VAPID keys present). When unconfigured, sends no-op gracefully.",
      handler: (_input, push) =>
        push.isConfigured()
          ? "web push is configured (VAPID keys present)"
          : "web push is NOT configured — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY",
      input: Type.Object({}),
    }),
    send_test_push: tool.runtime({
      annotations: { idempotentHint: true, openWorldHint: true },
      authorization: {
        approval: "always",
        audience: "owner",
        destinationFields: ["endpoint"],
        effects: ["send", "external-network"],
        idempotency: { mode: "host" },
        requiredScopes: ["pwa:push:send"],
        resource: { idField: "endpoint", type: "push-subscription" },
        reversible: false,
      },
      description:
        "Send one push notification to a specific subscription (endpoint + keys, as stored when the visitor enabled push). Reports whether the push service accepted it and whether the endpoint is permanently gone (prune it if so).",
      handler: async ({ auth, body, endpoint, p256dh, title, url }, push) => {
        const result = await push.send(
          { endpoint, keys: { auth, p256dh } },
          { body, title, ...(url !== undefined ? { url } : {}) },
        );

        return result.ok
          ? "push accepted by the push service"
          : result.gone
            ? "endpoint is permanently gone (404/410) — remove this subscription from storage"
            : "push failed (not configured, or the push service rejected it)";
      },
      input: Type.Object({
        auth: Type.String({
          description: "The subscription's auth key.",
          minLength: 1,
        }),
        body: Type.String({ minLength: 1 }),
        endpoint: Type.String({
          description: "The subscription's push-service endpoint URL.",
          format: "uri",
        }),
        p256dh: Type.String({
          description: "The subscription's p256dh key.",
          minLength: 1,
        }),
        title: Type.String({ minLength: 1 }),
        url: Type.Optional(
          Type.String({
            description: "Page opened when the notification is tapped.",
          }),
        ),
      }),
    }),
  },
  wiring: [
    {
      description:
        "Serve webAppManifest as application/manifest+json at /manifest.webmanifest, and serviceWorkerScript as text/javascript at /sw.js with a `Service-Worker-Allowed: /` header. Register it in the browser with registerServiceWorker() from @absolutejs/pwa/client.",
      id: "default",
      server: {
        code: [
          "const webAppManifest = createWebAppManifest(${settings.appManifest});",
          "const serviceWorkerScript = pushServiceWorker(${settings.serviceWorker});",
        ].join("\n"),
        imports: [
          {
            from: "@absolutejs/pwa",
            names: ["createWebAppManifest", "pushServiceWorker"],
          },
        ],
        placement: "module-scope",
      },
      title: "Serve the app manifest and service worker",
    },
    {
      description:
        "The VAPID sender. Fan out with push.sendMany(subscriptions, payload) and prune the endpoints it reports gone.",
      id: "web-push",
      server: {
        code: "const push = createWebPush({ privateKey: ${env.VAPID_PRIVATE_KEY}, publicKey: ${env.VAPID_PUBLIC_KEY}, ...${settings.webPush} });",
        imports: [{ from: "@absolutejs/pwa", names: ["createWebPush"] }],
        placement: "module-scope",
      },
      title: "Create the Web Push sender",
    },
  ],
});
