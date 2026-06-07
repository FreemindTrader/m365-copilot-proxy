import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".config", "opencode-m365");
const LOG_FILE = join(LOG_DIR, "debug.log");

// M365_TRACE implies debug logging and disables all payload truncation, so
// every WS frame, prompt, and response is recorded in full for reverse
// engineering. M365_DEBUG keeps the lighter, truncated logging.
const trace = !!process.env.M365_TRACE;
const enabled = !!process.env.M365_DEBUG || trace;

function timestamp(): string {
  return new Date().toISOString();
}

function write(level: string, component: string, ...args: unknown[]) {
  if (!enabled) return;
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ");
  const line = `[${timestamp()}] [${level}] [${component}] ${msg}\n`;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch {
    // best effort
  }
}

export function createLogger(component: string) {
  return {
    info: (...args: unknown[]) => write("INFO", component, ...args),
    error: (...args: unknown[]) => write("ERROR", component, ...args),
    debug: (...args: unknown[]) => write("DEBUG", component, ...args),
  };
}

/**
 * Truncate a string for logging unless M365_TRACE is set, in which case the
 * full value is returned so the debug file captures complete payloads.
 */
export function trunc(value: string, limit: number): string {
  if (trace) return value;
  return value.slice(0, limit);
}

export const LOG_PATH = LOG_FILE;
