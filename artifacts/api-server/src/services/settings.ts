import { archiveDb } from "../lib/archive-db";

export const webhookProviders = ["sonarr", "radarr"] as const;
export type WebhookProvider = (typeof webhookProviders)[number];
export type WebhookRotationMode = "overlap" | "cutover";

const MINIMUM_WEBHOOK_SECRET_LENGTH = 16;
const MAXIMUM_OVERLAP_MINUTES = 24 * 60;

interface StoredWebhookSecret {
  activeSecret: string;
  previousSecret: string | null;
  previousExpiresAt: string | null;
}

export interface WebhookSecretStatus {
  provider: WebhookProvider;
  configured: boolean;
  overlapUntil: string | null;
}

function settingKey(provider: WebhookProvider) {
  return `integration.webhook.${provider}`;
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

  return readWebhookSecretStatus(provider, env, now);
}