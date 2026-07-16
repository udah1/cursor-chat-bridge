import fs from "node:fs";
import path from "node:path";
import { RUNTIME_DIR } from "./paths.js";

// package.json ships in the npm tarball and sits one level up from dist/version.js.
const PKG_URL = new URL("../package.json", import.meta.url);
const CACHE_PATH = path.join(RUNTIME_DIR, "update-check.json");
// Don't hammer the registry: reuse a recent result for a few hours.
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

interface Pkg {
  name: string;
  version: string;
}

function pkg(): Pkg {
  try {
    const raw = JSON.parse(fs.readFileSync(PKG_URL, "utf8"));
    return { name: raw.name ?? "cursor-telegram-chat", version: raw.version ?? "0.0.0" };
  } catch {
    return { name: "cursor-telegram-chat", version: "0.0.0" };
  }
}

export function currentVersion(): string {
  return pkg().version;
}

export function packageName(): string {
  return pkg().name;
}

/** Compare two dotted numeric versions (prerelease suffixes ignored). >0 if a is newer than b. */
function cmp(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface UpdateInfo {
  current: string;
  latest?: string;
  updateAvailable: boolean;
}

/**
 * Best-effort check for a newer published version. Caches the result and swallows all errors
 * (offline / corporate proxy / registry down) so it never blocks or breaks bridge activation.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const { name, version: current } = pkg();

  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    if (cached && cached.current === current && typeof cached.at === "number" && Date.now() - cached.at < CHECK_TTL_MS) {
      const latest = cached.latest as string | undefined;
      return { current, latest, updateAvailable: !!latest && cmp(latest, current) > 0 };
    }
  } catch {}

  let latest: string | undefined;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (res.ok) {
      const body = (await res.json()) as { version?: string };
      if (body?.version) latest = body.version;
    }
  } catch {}

  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ at: Date.now(), current, latest }));
  } catch {}

  return { current, latest, updateAvailable: !!latest && cmp(latest, current) > 0 };
}
