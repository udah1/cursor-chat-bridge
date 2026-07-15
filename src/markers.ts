import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MARKERS_DIR, ensureRuntimeDir } from "./paths.js";

export interface Marker {
  sessionId: string;
  adapter: string;
  thread: string | null;
  cwd: string;
  active: boolean;
  updatedAt: number;
}

export function markerKey(cwd: string): string {
  return crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 16);
}

function markerPath(cwd: string): string {
  return path.join(MARKERS_DIR, `${markerKey(cwd)}.json`);
}

const LATEST = () => path.join(MARKERS_DIR, "latest.json");

export function writeMarker(m: Marker): void {
  ensureRuntimeDir();
  const data = JSON.stringify(m, null, 2);
  fs.writeFileSync(markerPath(m.cwd), data);
  fs.writeFileSync(LATEST(), data);
}

export function readMarker(cwd: string): Marker | null {
  try {
    return JSON.parse(fs.readFileSync(markerPath(cwd), "utf8"));
  } catch {
    try {
      return JSON.parse(fs.readFileSync(LATEST(), "utf8"));
    } catch {
      return null;
    }
  }
}

export function clearMarker(cwd: string): void {
  const active = readMarker(cwd);
  if (active) writeMarker({ ...active, active: false, updatedAt: Date.now() });
  try {
    fs.rmSync(markerPath(cwd), { force: true });
  } catch {}
}
