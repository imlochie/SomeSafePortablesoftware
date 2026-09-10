import { addEvent, archiveDb, LEGACY_OWNER_ID } from "../lib/archive-db";

export const webhookProviders = ["sonarr", "radarr"] as const;
export type WebhookProvider = (typeof webhookProviders)[number];
export type WebhookRotationMode = "overlap" | "cutover";
export interface WebhookRotationAudit {
  ownerId: string;
  operatorId: string;
}
export const webhookDeliveryResultClasses = [
  "accepted",
  "rejected",
  "unavailable",
  "malformed",
] as const;
export type WebhookDeliveryResultClass = (typeof webhookDeliveryResultClasses)[number];

const MINIMUM_WEBHOOK_SECRET_LENGTH = 16;
const MAXIMUM_OVERLAP_MINUTES = 24 * 60;
const WEBHOOK_DIAGNOSTICS_WINDOW_MS = 24 * 60 * 60 * 1000;

interface StoredWebhookSecret {
  activeSecret: string;
  previousSecret: string | null;
  previousExpiresAt: string | null;
}

export interface WebhookSecretStatus {
  provider: WebhookProvider;
  configured: boolean;
  overlapUntil: string | null;
  diagnostics: WebhookDeliveryDiagnostics;
}

export interface WebhookDeliveryCounts {
  accepted: number;
  rejected: number;
  unavailable: number;
  malformed: number;
}

export interface WebhookDeliveryDiagnostics {
  windowStartedAt: string;
  lastReceivedAt: string | null;
  lastResult: WebhookDeliveryResultClass | null;
  counts: WebhookDeliveryCounts;
}

function settingKey(provider: WebhookProvider) {
  return `integration.webhook.${provider}`;
}

function diagnosticsSettingKey(provider: WebhookProvider) {
  return `integration.webhook.${provider}.diagnostics`;
}

function environmentKey(provider: WebhookProvider) {
  return provider === "sonarr" ? "SONARR_WEBHOOK_SECRET" : "RADARR_WEBHOOK_SECRET";
}

function readStoredWebhookSecret(provider: WebhookProvider): StoredWebhookSecret | null {
  const row = archiveDb
    .prepare("SELECT value FROM setting WHERE key = ?")
    .get(settingKey(provider)) as { value?: string } | undefined;
  if (!row?.value) return null;

  try {
    const value = JSON.parse(row.value) as Partial<StoredWebhookSecret>;
    if (typeof value.activeSecret !== "string" || !value.activeSecret) return null;
    return {
      activeSecret: value.activeSecret,
      previousSecret: typeof value.previousSecret === "string" && value.previousSecret
        ? value.previousSecret
        : null,
      previousExpiresAt: typeof value.previousExpiresAt === "string" && value.previousExpiresAt
        ? value.previousExpiresAt
        : null,
    };
  } catch {
    return null;
  }
}

function environmentSecret(provider: WebhookProvider, env: NodeJS.ProcessEnv) {
  const value = env[environmentKey(provider)]?.trim();
  return value || null;
}

function isActiveExpiry(value: string | null, now = Date.now()) {
  return Boolean(value && Date.parse(value) > now);
}

function emptyWebhookDeliveryCounts(): WebhookDeliveryCounts {
  return {
    accepted: 0,
    rejected: 0,
    unavailable: 0,
    malformed: 0,
  };
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readWebhookDeliveryDiagnostics(
  provider: WebhookProvider,
  now = Date.now(),
): WebhookDeliveryDiagnostics {
  const row = archiveDb
    .prepare("SELECT value FROM setting WHERE key = ?")
    .get(diagnosticsSettingKey(provider)) as { value?: string } | undefined;
  let parsed: Partial<WebhookDeliveryDiagnostics> = {};
  try {
    parsed = row?.value ? JSON.parse(row.value) as Partial<WebhookDeliveryDiagnostics> : {};
  } catch {
    parsed = {};
  }

  const storedWindowStartedAt = typeof parsed.windowStartedAt === "string"
    && Number.isFinite(Date.parse(parsed.windowStartedAt))
    ? parsed.windowStartedAt
    : null;
  const windowStartedAt = storedWindowStartedAt
    && Date.parse(storedWindowStartedAt) > now - WEBHOOK_DIAGNOSTICS_WINDOW_MS
    ? storedWindowStartedAt
    : new Date(now).toISOString();
  const storedCounts = parsed.counts && typeof parsed.counts === "object"
    ? parsed.counts as Partial<WebhookDeliveryCounts>
    : {};
  const counts = windowStartedAt === storedWindowStartedAt
    ? {
      accepted: nonNegativeInteger(storedCounts.accepted),
      rejected: nonNegativeInteger(storedCounts.rejected),
      unavailable: nonNegativeInteger(storedCounts.unavailable),
      malformed: nonNegativeInteger(storedCounts.malformed),
    }
    : emptyWebhookDeliveryCounts();
  const lastResult = windowStartedAt === storedWindowStartedAt
    && webhookDeliveryResultClasses.includes(parsed.lastResult as WebhookDeliveryResultClass)
    ? parsed.lastResult as WebhookDeliveryResultClass
    : null;
  const lastReceivedAt = windowStartedAt === storedWindowStartedAt
    && typeof parsed.lastReceivedAt === "string"
    && Number.isFinite(Date.parse(parsed.lastReceivedAt))
    ? parsed.lastReceivedAt
    : null;
  return {
    windowStartedAt,
    lastReceivedAt,
    lastResult,
    counts,
  };
}

export function recordWebhookDelivery(
  provider: WebhookProvider,
  result: WebhookDeliveryResultClass,
  now = Date.now(),
) {
  if (!webhookDeliveryResultClasses.includes(result)) {
    throw new Error("Webhook delivery result class is not supported.");
  }
  const current = readWebhookDeliveryDiagnostics(provider, now);
  const diagnostics: WebhookDeliveryDiagnostics = {
    ...current,
    lastReceivedAt: new Date(now).toISOString(),
    lastResult: result,
    counts: {
      ...current.counts,
      [result]: current.counts[result] + 1,
    },
  };
  archiveDb
    .prepare(
      "INSERT INTO setting (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
    )
    .run(diagnosticsSettingKey(provider), JSON.stringify(diagnostics));
  return diagnostics;
}

export function getWebhookDeliveryDiagnostics(
  provider: WebhookProvider,
  now = Date.now(),
) {
  return readWebhookDeliveryDiagnostics(provider, now);
}

export function readWebhookSecretCandidates(
  provider: WebhookProvider,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
) {
  const stored = readStoredWebhookSecret(provider);
  const activeSecret = stored?.activeSecret ?? environmentSecret(provider, env);
  const candidates = activeSecret ? [activeSecret] : [];
  if (stored?.previousSecret && isActiveExpiry(stored.previousExpiresAt, now)) {
    candidates.push(stored.previousSecret);
  }
  return [...new Set(candidates)];
}

export function readWebhookSecretStatus(
  provider: WebhookProvider,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): WebhookSecretStatus {
  const stored = readStoredWebhookSecret(provider);
  const activeSecret = stored?.activeSecret ?? environmentSecret(provider, env);
  const overlapUntil = stored?.previousSecret && isActiveExpiry(stored.previousExpiresAt, now)
    ? stored.previousExpiresAt
    : null;
  return {
    provider,
    configured: Boolean(activeSecret),
    overlapUntil,
    diagnostics: readWebhookDeliveryDiagnostics(provider, now),
  };
}

export function readWebhookSecretStatuses(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
) {
  return webhookProviders.map((provider) => readWebhookSecretStatus(provider, env, now));
}

function validateSecret(secret: unknown) {
  if (typeof secret !== "string") {
    throw new Error("Webhook secret must be a string.");
  }
  const normalized = secret.trim();
  if (normalized.length < MINIMUM_WEBHOOK_SECRET_LENGTH) {
    throw new Error(`Webhook secret must be at least ${MINIMUM_WEBHOOK_SECRET_LENGTH} characters.`);
  }
  return normalized;
}

export function rotateWebhookSecret(
  provider: WebhookProvider,
  input: {
    secret: unknown;
    mode: WebhookRotationMode;
    overlapMinutes?: number;
  },
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  audit: WebhookRotationAudit = {
    ownerId: LEGACY_OWNER_ID,
    operatorId: "system",
  },
) {
  const secret = validateSecret(input.secret);
  if (input.mode !== "overlap" && input.mode !== "cutover") {
    throw new Error("Webhook rotation mode must be overlap or cutover.");
  }
  const overlapMinutes = input.overlapMinutes;
  if (
    input.mode === "overlap"
    && (overlapMinutes === undefined
      || !Number.isInteger(overlapMinutes)
      || overlapMinutes < 1
      || overlapMinutes > MAXIMUM_OVERLAP_MINUTES)
  ) {
    throw new Error(`Overlap duration must be between 1 and ${MAXIMUM_OVERLAP_MINUTES} minutes.`);
  }

  const current = readStoredWebhookSecret(provider);
  const currentActive = current?.activeSecret ?? environmentSecret(provider, env);
  const previousSecret = input.mode === "overlap" && currentActive && currentActive !== secret
    ? currentActive
    : null;
  const previousExpiresAt = previousSecret
    ? new Date(now + (overlapMinutes ?? 0) * 60_000).toISOString()
    : null;
  const next: StoredWebhookSecret = {
    activeSecret: secret,
    previousSecret,
    previousExpiresAt,
  };

  archiveDb
    .prepare(
      "INSERT INTO setting (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
    )
    .run(settingKey(provider), JSON.stringify(next));

  addEvent(
    "success",
    `Webhook secret rotated for ${provider} using ${input.mode} mode.`,
    "integrations",
    audit.ownerId,
    audit.operatorId,
    new Date(now).toISOString(),
  );

  return readWebhookSecretStatus(provider, env, now);
}