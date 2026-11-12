/**
 * Local discovery for the WorkBuddy entry.
 *
 * The desktop app keeps a signed-in account and an account-level model catalog
 * on disk. Both are read here so the model list can be filled without asking the
 * user anything — and without touching credentials: only `account` identity
 * fields and `auth.expiresAt` are inspected, while sealed token envelopes are
 * left exactly as they are.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  accountLevelModels,
  mergeCatalogs,
  normalizeDesktopModel,
} from "./catalog.ts";
import {
  storageFiles,
  workBuddyAccountStores,
  workBuddyConnectorCatalog,
  workBuddyDataDirs,
  workBuddyExecutables,
  workBuddyStorageDirs,
  type WorkBuddyEnvironment,
} from "./paths.ts";
import type { WorkBuddyDiscovery, WorkBuddyModel } from "./types.ts";

/** Clock skew allowed before a stored session counts as expired. */
const EXPIRY_SKEW_MS = 120_000;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Account identity plus session expiry out of one auth store. */
function readAccountStore(path: string): {
  uid?: string;
  enterpriseId?: string;
  enterpriseName?: string;
  accountType?: string;
  expiresAt?: number;
  sealedToken: boolean;
} | null {
  const record = asRecord(readJson(path));
  if (!record) return null;
  const account = asRecord(record.account) ?? {};
  const auth = asRecord(record.auth) ?? asRecord(record) ?? {};
  // An envelope is an object; a plain token is a string. Only the shape is
  // inspected — the value is never read out.
  const tokenShape = auth.accessToken;
  const sealedToken =
    typeof tokenShape === "object" && tokenShape !== null && !Array.isArray(tokenShape);
  return {
    uid: text(account.uid) ?? text(account.user && asRecord(account.user)?.uid),
    enterpriseId: text(account.enterpriseId),
    enterpriseName: text(account.enterpriseName),
    accountType: text(account.type) ?? text(account.accountType),
    expiresAt: count(auth.expiresAt),
    sealedToken,
  };
}

/** Every model one `local_storage` file declares, in either shape it uses. */
function modelsFromStorageFile(path: string): WorkBuddyModel[] {
  const parsed = readJson(path);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const models: WorkBuddyModel[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const declared = record?.data && asRecord(record.data)?.models;
    if (!Array.isArray(declared)) continue;
    for (const raw of declared) {
      const model = normalizeDesktopModel(raw);
      if (model) models.push(model);
    }
  }
  return models;
}

function modelsFromStorage(dirs: readonly string[]): WorkBuddyModel[] {
  const models: WorkBuddyModel[] = [];
  for (const dir of dirs) {
    for (const file of storageFiles(dir)) models.push(...modelsFromStorageFile(file));
  }
  return models;
}

/** Models the optional local connector cached, flattened across accounts. */
function modelsFromConnector(path: string): WorkBuddyModel[] {
  const entries = asRecord(asRecord(readJson(path))?.entries);
  if (!entries) return [];
  const models: WorkBuddyModel[] = [];
  for (const value of Object.values(entries)) {
    const declared = asRecord(value)?.models;
    if (!Array.isArray(declared)) continue;
    for (const raw of declared) {
      const model = normalizeDesktopModel(raw);
      if (model) models.push(model);
    }
  }
  return models;
}

/**
 * Inspect the machine for a WorkBuddy install, its sign-in state, and the models
 * the signed-in account can use.
 *
 * Never throws: a permission error, a half-written file, or a missing directory
 * all read as "not found", because the entry is optional and must not block
 * startup.
 */
export function detectWorkBuddy(environment: WorkBuddyEnvironment): WorkBuddyDiscovery {
  const now = environment.now ?? Date.now();
  const sources: string[] = [];

  const executables = environment.executables ?? workBuddyExecutables(environment);
  const executable = executables.find((path) => existsSync(path));
  if (executable) sources.push("install");
  const dataDir = workBuddyDataDirs(environment).find((dir) => existsSync(dir));
  if (dataDir) sources.push("profile");

  let account: ReturnType<typeof readAccountStore> = null;
  let storePath: string | undefined;
  for (const path of workBuddyAccountStores(environment)) {
    if (!existsSync(path)) continue;
    const found = readAccountStore(path);
    if (!found) continue;
    account = found;
    storePath = path;
    sources.push("auth-store");
    break;
  }

  const installed = Boolean(executable || dataDir || account);
  const expiresAt = account?.expiresAt;
  const unexpired = typeof expiresAt === "number" && expiresAt > now + EXPIRY_SKEW_MS;
  const loggedIn = Boolean(account?.uid && unexpired);

  let detail: string | undefined;
  if (!installed) detail = "WorkBuddy is not installed on this machine";
  else if (!account) detail = "No WorkBuddy sign-in record was found";
  else if (!account.uid) detail = "The WorkBuddy sign-in record names no account";
  else if (!unexpired) detail = "The WorkBuddy session has expired; sign in again in the app";
  else if (account.sealedToken && !storePath) detail = "The stored token is sealed";

  const storageDirs = workBuddyStorageDirs(environment).filter((dir) => existsSync(dir));
  if (storageDirs.length) sources.push("model-cache");
  const connector = workBuddyConnectorCatalog(environment);
  if (existsSync(connector)) sources.push("connector-catalog");

  const fromStorage = accountLevelModels(modelsFromStorage(storageDirs));
  const fromConnector = modelsFromConnector(connector);

  return {
    installation: {
      installed,
      loggedIn,
      account: account
        ? {
            uid: account.uid,
            enterpriseId: account.enterpriseId,
            enterpriseName: account.enterpriseName,
            accountType: account.accountType,
          }
        : undefined,
      expiresAt,
      sources,
      detail,
    },
    // The desktop cache describes this machine's account most precisely, so it
    // is the base; the connector catalog only fills in what it states better.
    models: mergeCatalogs([fromStorage, fromConnector]),
  };
}
