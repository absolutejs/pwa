import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  detail:
    "The `@absolutejs/devices` dependency accepted only 0.6, so apps on `@absolutejs/devices` 0.7, which every current AbsoluteJS mobile build installs, got a second copy just for this package. It now accepts 0.6 and 0.7.",
  kind: "fixed",
  summary: "Apps using @absolutejs/devices 0.7 no longer install a second copy",
};
