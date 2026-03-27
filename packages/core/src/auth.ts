import * as msal from "@azure/msal-node";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { exec } from "node:child_process";
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
  const { authUrl, verifier } = await buildAuthUrl(app);

  log.info("Starting automated login...");

  const { TOTP } = await import("otpauth");
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  const page = await browser.newPage();

  try {
    await page.goto(authUrl);

    log.info("Entering email...");
    await page.waitForSelector('input[type="email"]', { timeout: 15000 });
    await page.fill('input[type="email"]', email);
    await page.click('input[type="submit"]');

    log.info("Entering password...");
    await page.waitForSelector('input[type="password"]', { timeout: 15000 });
    await page.fill('input[type="password"]', password);
    await page.click('input[type="submit"]');

    log.info("Entering MFA code...");
    const totp = new TOTP({ secret: mfaSecret });
    const otpCode = totp.generate();

    await page.waitForSelector('input[name="otc"]', { timeout: 15000 });
    await page.fill('input[name="otc"]', otpCode);
    await page.click('input[type="submit"]');

    try {
      await page.waitForSelector('input[type="submit"]', { timeout: 5000 });
      await page.click('input[type="submit"]');
    } catch {
      // "Stay signed in?" may not appear
    }

    log.info("Waiting for redirect...");
    await page.waitForURL("**/oauth2/nativeclient**", { timeout: 15000 });

    const authCode = new URL(page.url()).searchParams.get("code");
    if (!authCode) throw new Error("No auth code in redirect URL");

    log.info("Got auth code, exchanging for token...");
    return await exchangeCode(app, authCode, verifier);
  } finally {
    await browser.close();
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
  if (accounts.length === 0) return null;

  try {
    const result = await app.acquireTokenSilent({
      scopes,
      account: accounts[0],
    });
    saveCache(app);
    return result.accessToken;
  } catch (err: any) {
    // Silent failed — try automated login with stored credentials
    log.info(`getTokenForScope: silent failed (${err.message}), trying automated login`);
    const secrets = loadSecrets();
    if (!secrets) return null;

    try {
      // Do a fresh PKCE flow for the new scope
      const { authUrl, verifier } = await buildAuthUrlForScopes(app, scopes);
      const { chromium } = await import("playwright");
      const { TOTP } = await import("otpauth");

      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_PATH,
      });
      const page = await browser.newPage();

      try {
        await page.goto(authUrl);
        await page.waitForSelector('input[type="email"]', { timeout: 15000 });
        await page.fill('input[type="email"]', secrets.email);
        await page.click('input[type="submit"]');

        await page.waitForSelector('input[type="password"]', { timeout: 15000 });
        await page.fill('input[type="password"]', secrets.password);
        await page.click('input[type="submit"]');

        const totp = new TOTP({ secret: secrets.mfaSecret });
        const otpCode = totp.generate();
        await page.waitForSelector('input[name="otc"]', { timeout: 15000 });
        await page.fill('input[name="otc"]', otpCode);
        await page.click('input[type="submit"]');

        try {
          await page.waitForSelector('input[type="submit"]', { timeout: 5000 });
          await page.click('input[type="submit"]');
        } catch {}

        await page.waitForURL("**/oauth2/nativeclient**", { timeout: 15000 });
        const authCode = new URL(page.url()).searchParams.get("code");
        if (!authCode) return null;

        const result = await app.acquireTokenByCode({
          code: authCode,
          scopes,
          redirectUri: REDIRECT_URI,
          codeVerifier: verifier,
        });
        saveCache(app);
        log.info(`Got token for scope: ${scopes.join(", ")}`);
        return result.accessToken;
      } finally {
        await browser.close();
      }
    } catch (err: any) {
      log.error("Automated scope login failed:", err.message);
      return null;
    }
  }
}

export async function getToken(): Promise<string> {
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
