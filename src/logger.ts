import fs from "node:fs";
import { LOG_PATH, ensureRuntimeDir } from "./paths.js";

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    ensureRuntimeDir();
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // ignore log failures
  }
  // Also to stderr so it shows up when run in a terminal.
  process.stderr.write(line);
}
