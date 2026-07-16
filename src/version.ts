import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";
import { RUNTIME_DIR } from "./paths.js";

// package.json ships in the npm tarball and sits one level up from dist/version.js.
const PKG_URL = new URL("../package.json", import.meta.url);
const CACHE_PATH = path.join(RUNTIME_DIR, "update-check.json");
const CONFIG_PATH = path.join(RUNTIME_DIR, "config.json");
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
 * On a TLS-intercepting corporate network (e.g. Amdocs) the registry cert is re-signed by a private
 * root that Node doesn't trust out of the box. Mirror the daemon's resolution order — NODE_EXTRA_CA_CERTS,
 * BRIDGE_CA_CERT, then config.caCertPath — and return the extra CA so we can *add* it to the defaults.
 */
function extraCa(): Buffer | undefined {
  const candidates = [process.env.NODE_EXTRA_CA_CERTS, process.env.BRIDGE_CA_CERT];
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (cfg && typeof cfg.caCertPath === "string" && cfg.caCertPath) candidates.push(cfg.caCertPath);
  } catch {}
  for (const p of candidates) {
    if (!p) continue;
    try {
      const buf = fs.readFileSync(p);
      if (buf.length) return buf;
    } catch {}
  }
  return undefined;
}

/** Fetch the published "latest" version via node:https so we can add the corporate CA to trust. */
function fetchLatestVersion(name: string): Promise<string | undefined> {
  const ca = extraCa();
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
      {
        headers: { accept: "application/json" },
        timeout: FETCH_TIMEOUT_MS,
        // Add the extra CA on top of the defaults (never replace them), like NODE_EXTRA_CA_CERTS.
        ca: ca ? [...tls.rootCertificates, ca] : undefined,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(undefined);
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve((JSON.parse(data) as { version?: string })?.version);
          } catch {
            resolve(undefined);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
  });
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
    latest = await fetchLatestVersion(name);
  } catch {}

  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ at: Date.now(), current, latest }));
  } catch {}

  return { current, latest, updateAvailable: !!latest && cmp(latest, current) > 0 };
}
