import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".config", "opencode-m365");
const LOG_FILE = join(LOG_DIR, "debug.log");

const enabled = !!process.env.M365_DEBUG;

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

export const LOG_PATH = LOG_FILE;
