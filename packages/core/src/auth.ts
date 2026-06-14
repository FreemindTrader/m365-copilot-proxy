import * as msal from "@azure/msal-node";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { exec, execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
const AUTHORITY = "https://login.microsoftonline.com/common";
const REDIRECT_URI =
  "https://login.microsoftonline.com/common/oauth2/nativeclient";
const SCOPES = [
  "https://substrate.office.com/sydney/M365Chat.Read",
  "https://substrate.office.com/sydney/sydney.readwrite",
];

import { createLogger } from "./log.js";
const log = createLogger("auth");

const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");

function resolveFile(envVar: string, defaultName: string): string {
  if (process.env[envVar]) return process.env[envVar]!;
  mkdirSync(CONFIG_DIR, { recursive: true });
  return join(CONFIG_DIR, defaultName);
}

const CACHE_FILE = resolveFile("M365_CACHE_FILE", "msal-cache.json");
const SECRETS_FILE = resolveFile("M365_SECRETS_FILE", "secrets.json");

// --- MSAL cache persistence ---

function loadCache(app: msal.PublicClientApplication) {
  if (existsSync(CACHE_FILE)) {
    try {
      app.getTokenCache().deserialize(readFileSync(CACHE_FILE, "utf-8"));
    } catch {}
  }
}

function saveCache(app: msal.PublicClientApplication) {
  try {
    writeFileSync(CACHE_FILE, app.getTokenCache().serialize());
  } catch {}
}

let _app: msal.PublicClientApplication | null = null;

function getApp(): msal.PublicClientApplication {
  if (!_app) {
    _app = new msal.PublicClientApplication({
      auth: { clientId: CLIENT_ID, authority: AUTHORITY },
    });
    loadCache(_app);
  }
  return _app;
}

// --- PKCE helpers ---

async function buildAuthUrlForScopes(app: msal.PublicClientApplication, scopes: string[]) {
  const cryptoProvider = new msal.CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();

  const authUrl = await app.getAuthCodeUrl({
    scopes,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });

  return { authUrl, verifier };
}

async function buildAuthUrl(app: msal.PublicClientApplication) {
  const cryptoProvider = new msal.CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();

  const authUrl = await app.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    prompt: "select_account",
  });

  return { authUrl, verifier };
}

async function exchangeCode(
  app: msal.PublicClientApplication,
  code: string,
  verifier: string,
): Promise<string> {
  const result = await app.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    codeVerifier: verifier,
  });
  saveCache(app);
  log.info(`Logged in as ${result.account?.name} (${result.account?.username})`);
  return result.accessToken;
}

// --- Shared automated browser login ---

const LOGIN_DEBUG_DIR = join(CONFIG_DIR, "login-debug");

interface Credentials {
  email: string;
  password: string;
  mfaSecret: string;
}

/**
 * Resolve a usable Chromium executable. Playwright's bundled chrome-headless-shell
 * is not patched for NixOS (fails on libglib-2.0.so.0), so prefer an explicit
 * CHROMIUM_PATH, then a system chromium on PATH. Returns undefined to let
 * Playwright use its bundled browser (works on patched/standard distros).
 */
function resolveChromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const bin of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
    try {
      const found = execSync(`command -v ${bin}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (found) {
        log.info(`Resolved system browser: ${found}`);
        return found;
      }
    } catch {
      // not on PATH, try next
    }
  }
  return undefined;
}

async function capture(page: any, label: string): Promise<void> {
  try {
    mkdirSync(LOGIN_DEBUG_DIR, { recursive: true });
    await page.screenshot({
      path: join(LOGIN_DEBUG_DIR, `${label}.png`),
      fullPage: true,
    });
    writeFileSync(join(LOGIN_DEBUG_DIR, `${label}.html`), await page.content());
    // Write the URL unconditionally (independent of the debug-log flag).
    writeFileSync(join(LOGIN_DEBUG_DIR, `${label}.url.txt`), page.url());
    log.info(`Captured ${label} — url: ${page.url()}`);
  } catch (e: any) {
    log.error(`Failed to capture ${label}: ${e?.message}`);
  }
}

/**
 * Fill a visible input and verify the value actually landed. The converged AAD
 * login page keeps hidden duplicate inputs around, so a naive fill can target a
 * stale hidden node and leave the visible field empty. Refill via typing if so.
 */
async function fillVerified(
  page: any,
  selector: string,
  value: string,
  label: string,
): Promise<void> {
  const loc = page.locator(`${selector}:visible`).first();
  await loc.waitFor({ state: "visible", timeout: 20000 });
  await loc.click();
  await loc.fill(value);
  let got = await loc.inputValue();
  if (got !== value) {
    log.info(`${label}: fill mismatch (${got.length} chars), retyping`);
    await loc.fill("");
    await loc.pressSequentially(value, { delay: 20 });
    got = await loc.inputValue();
  }
  if (got !== value) {
    throw new Error(`${label}: field still empty after refill`);
  }
}

/** Click the visible primary submit button (Next / Sign in / Verify / Yes). */
async function clickSubmit(page: any): Promise<void> {
  await page
    .locator('input[type="submit"]:visible, button[type="submit"]:visible')
    .first()
    .click();
}

/** Drive the Azure AD interactive login form using stored credentials + TOTP. */
async function driveAzureLogin(page: any, creds: Credentials): Promise<void> {
  const { TOTP } = await import("otpauth");

  await capture(page, "step0-landing");

  log.info("Step: email");
  await fillVerified(page, 'input[name="loginfmt"]', creds.email, "email");
  await clickSubmit(page);
  await capture(page, "step1-after-email");

  log.info("Step: password");
  await fillVerified(page, 'input[name="passwd"]', creds.password, "password");
  await clickSubmit(page);
  await capture(page, "step2-after-password");

  log.info("Step: mfa");
  const otpCode = new TOTP({ secret: creds.mfaSecret }).generate();
  await fillVerified(page, 'input[name="otc"]', otpCode, "otc");
  await clickSubmit(page);
  await capture(page, "step3-after-mfa");

  // "Stay signed in?" — may or may not appear
  log.info("Step: stay-signed-in");
  try {
    await page.locator("#idSIButton9:visible").click({ timeout: 8000 });
  } catch {
    // not shown
  }
}

/**
 * Acquire a token for the given scopes via a headless browser login.
 * Retries up to `attempts` times, capturing screenshots/HTML on each failure.
 * TOTP codes are single-use per 30s window, so retries wait for a fresh window.
 * Returns null if all attempts fail.
 */
async function runBrowserLogin(
  app: msal.PublicClientApplication,
  scopes: string[],
  creds: Credentials,
  attempts = 3,
): Promise<string | null> {
  const { chromium } = await import("playwright");

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { authUrl, verifier } = await buildAuthUrlForScopes(app, scopes);
    const browser = await chromium.launch({
      headless: true,
      executablePath: resolveChromiumPath(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();

    // The nativeclient redirect URI is meant for embedded native hosts to
    // intercept; a real browser follows it one hop further to /common/wrongplace,
    // so the ?code= only exists transiently. Capture it from the navigation
    // request itself rather than waiting for the URL to settle.
    let resolveCode: (code: string) => void;
    const codePromise = new Promise<string>((res) => {
      resolveCode = res;
    });
    page.on("request", (req: any) => {
      const u = req.url();
      if (u.includes("/oauth2/nativeclient") && u.includes("code=")) {
        const c = new URL(u).searchParams.get("code");
        if (c) {
          log.info("Captured auth code from nativeclient redirect");
          resolveCode(c);
        }
      }
    });

    try {
      log.info(`Browser login attempt ${attempt}/${attempts} for [${scopes.join(", ")}]`);
      await page.goto(authUrl, { waitUntil: "domcontentloaded" });
      await driveAzureLogin(page, creds);

      const authCode = await Promise.race([
        codePromise,
        new Promise<string>((_, rej) =>
          setTimeout(() => rej(new Error("Timed out waiting for auth code")), 30000),
        ),
      ]);

      const result = await app.acquireTokenByCode({
        code: authCode,
        scopes,
        redirectUri: REDIRECT_URI,
        codeVerifier: verifier,
      });
      saveCache(app);
      log.info(`Browser login succeeded as ${result.account?.username}`);
      return result.accessToken;
    } catch (err: any) {
      await capture(page, `attempt-${attempt}-fail`);
      log.error(`Browser login attempt ${attempt}/${attempts} failed: ${err.message}`);
      if (attempt < attempts) {
        // Wait for a fresh TOTP window so the next code isn't a reused one.
        await new Promise((r) => setTimeout(r, 31_000));
      }
    } finally {
      await browser.close();
    }
  }
  return null;
}

// --- Token acquisition methods ---

export async function getTokenSilent(): Promise<string | null> {
  const app = getApp();
  const accounts = await app.getTokenCache().getAllAccounts();
  if (accounts.length === 0) return null;

  try {
    const result = await app.acquireTokenSilent({
      scopes: SCOPES,
      account: accounts[0],
    });
    saveCache(app);
    return result.accessToken;
  } catch {
    return null;
  }
}

export async function loginInteractive(): Promise<string> {
  if (process.env.M365_NO_INTERACTIVE) {
    throw new Error(
      "Interactive login disabled (M365_NO_INTERACTIVE set) — refusing to open a browser",
    );
  }
  const app = getApp();
  const { authUrl, verifier } = await buildAuthUrl(app);

  exec(`xdg-open ${JSON.stringify(authUrl)}`);
  console.log("[auth] Browser opened for M365 login.");
  console.log("[auth] After login, paste the redirect URL here:");

  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const redirectUrl = await new Promise<string>((resolve) => {
    rl.question("> ", (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  const code = new URL(redirectUrl).searchParams.get("code");
  if (!code) throw new Error("No auth code found in URL");

  return exchangeCode(app, code, verifier);
}

export async function loginAutomated(
  email: string,
  password: string,
  mfaSecret: string,
): Promise<string> {
  const app = getApp();
  log.info("Starting automated login...");
  const token = await runBrowserLogin(
    app,
    SCOPES,
    { email, password, mfaSecret },
    1,
  );
  if (!token) {
    throw new Error(
      `Automated login failed — see artifacts in ${LOGIN_DEBUG_DIR}`,
    );
  }
  return token;
}

// Force a fresh login (new tokens), bypassing the silent cache. This is the
// throttle-recovery lever from docs/hypotheses.md §9 F13: account degradation is
// thread-rate, and fresh tokens clear it. Single-flight so concurrent triggers
// share one login instead of racing several browsers against the account.
let inflightReauth: Promise<boolean> | null = null;

export function forceReauth(): Promise<boolean> {
  return (inflightReauth ??= doForceReauth().finally(() => {
    inflightReauth = null;
  }));
}

async function doForceReauth(): Promise<boolean> {
  const secrets = loadSecrets();
  if (!secrets) {
    log.error("forceReauth: no secrets file — cannot re-login");
    return false;
  }
  try {
    const app = getApp();
    // Drop cached accounts so nothing can silently reuse the throttled token.
    const accounts = await app.getTokenCache().getAllAccounts();
    for (const acct of accounts) await app.getTokenCache().removeAccount(acct);
    saveCache(app);
    log.info("forceReauth: cleared cached accounts, doing fresh automated login");
    await loginAutomated(secrets.email, secrets.password, secrets.mfaSecret);
    log.info("forceReauth: fresh login succeeded");
    return true;
  } catch (err: any) {
    log.error(`forceReauth failed: ${err.message}`);
    return false;
  }
}

export function loadSecrets(): {
  email: string;
  password: string;
  mfaSecret: string;
} | null {
  if (!existsSync(SECRETS_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(SECRETS_FILE, "utf-8"));
    if (data.email && data.password && data.mfaSecret) return data;
  } catch {}
  return null;
}

export async function getTokenForScope(scopes: string[]): Promise<string | null> {
  const app = getApp();
  const accounts = await app.getTokenCache().getAllAccounts();
  log.info(`getTokenForScope: ${scopes.join(",")} — ${accounts.length} accounts in cache`);

  if (accounts.length > 0) {
    try {
      const result = await app.acquireTokenSilent({
        scopes,
        account: accounts[0],
      });
      saveCache(app);
      return result.accessToken;
    } catch (err: any) {
      log.info(`getTokenForScope: silent failed (${err.message}), trying browser login`);
    }
  }

  // Silent unavailable — fall back to automated browser login with stored creds.
  const secrets = loadSecrets();
  if (!secrets) return null;
  return runBrowserLogin(app, scopes, secrets);
}

// Serialize token acquisition: concurrent callers share one in-flight login
// instead of racing several browser logins against the same account.
let inflightToken: Promise<string> | null = null;

export function getToken(): Promise<string> {
  return (inflightToken ??= doGetToken().finally(() => {
    inflightToken = null;
  }));
}

async function doGetToken(): Promise<string> {
  const silent = await getTokenSilent();
  if (silent) {
    log.info("Token refreshed silently");
    return silent;
  }

  const secrets = loadSecrets();
  if (secrets) {
    try {
      return await loginAutomated(
        secrets.email,
        secrets.password,
        secrets.mfaSecret,
      );
    } catch (err: any) {
      log.error("Automated login failed:", err.message);
    }
  }

  return loginInteractive();
}
