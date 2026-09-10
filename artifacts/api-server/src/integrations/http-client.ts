import {
  IntegrationUnavailableError,
  type IntegrationId,
} from "./contracts";
import type { IntegrationConfiguration } from "./config";

export type IntegrationFailureKind =
  | "authentication"
  | "timeout"
  | "unreachable"
  | "http"
  | "malformed";

export class IntegrationHttpError extends Error {
  readonly kind: IntegrationFailureKind;
  readonly statusCode: number | null;

  constructor(
    message: string,
    kind: IntegrationFailureKind,
    statusCode: number | null = null,
  ) {
    super(message);
    this.name = "IntegrationHttpError";
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

function serviceName(id: IntegrationId) {
  return id === "qbittorrent" ? "qBittorrent" : id[0].toUpperCase() + id.slice(1);
}

function endpointUrl(config: IntegrationConfiguration, id: IntegrationId, path: string) {
  if (!config.endpoint) {
    throw new IntegrationUnavailableError(`${serviceName(id)} is not configured.`, {
      integrationId: id,
    });
  }
  let base: URL;
  try {
    base = new URL(config.endpoint);
  } catch {
    throw new IntegrationUnavailableError(`${serviceName(id)} has an invalid base URL.`, {
      integrationId: id,
    });
  }
  if (!["http:", "https:"].includes(base.protocol)) {
    throw new IntegrationUnavailableError(`${serviceName(id)} base URL must use HTTP or HTTPS.`, {
      integrationId: id,
    });
  }
  return new URL(path, `${base.toString().replace(/\/+$/, "")}/`);
}

export interface IntegrationHttpRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  signal?: AbortSignal;
  includeApiKey?: boolean;
  timeoutMs?: number;
}

export interface IntegrationHttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

export async function requestRaw(
  config: IntegrationConfiguration,
  id: IntegrationId,
  path: string,
  options: IntegrationHttpRequest = {},
): Promise<IntegrationHttpResponse> {
  const url = endpointUrl(config, id, path);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortExternal = () => controller.abort();
  options.signal?.addEventListener("abort", abortExternal, { once: true });

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };
  if (options.includeApiKey !== false && config.apiKey) {
    headers["X-Api-Key"] = config.apiKey;
  }

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      signal: controller.signal,
      redirect: "error",
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new IntegrationHttpError(
        `${serviceName(id)} rejected the configured credentials.`,
        "authentication",
        response.status,
      );
    }
    if (!response.ok) {
      throw new IntegrationHttpError(
        `${serviceName(id)} returned HTTP ${response.status}.`,
        "http",
        response.status,
      );
    }
    return { status: response.status, headers: response.headers, text };
  } catch (error) {
    if (error instanceof IntegrationHttpError) throw error;
    if (timedOut || (error instanceof DOMException && error.name === "AbortError")) {
      throw new IntegrationHttpError(
        `${serviceName(id)} did not respond before the timeout.`,
        "timeout",
      );
    }
    throw new IntegrationHttpError(
      `${serviceName(id)} could not be reached.`,
      "unreachable",
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortExternal);
  }
}

export async function requestText(
  config: IntegrationConfiguration,
  id: IntegrationId,
  path: string,
  options: IntegrationHttpRequest = {},
) {
  return (await requestRaw(config, id, path, options)).text;
}

export async function requestJson<T>(
  config: IntegrationConfiguration,
  id: IntegrationId,
  path: string,
  options: IntegrationHttpRequest = {},
): Promise<T> {
  const response = await requestRaw(config, id, path, options);
  if (!response.text.trim()) {
    throw new IntegrationHttpError(
      `${serviceName(id)} returned an empty response.`,
      "malformed",
    );
  }
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new IntegrationHttpError(
      `${serviceName(id)} returned malformed JSON.`,
      "malformed",
    );
  }
}

export function responseRecord(value: unknown, service: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrationHttpError(
      `${service} returned an unexpected response shape.`,
      "malformed",
    );
  }
  return value as Record<string, unknown>;
}

export function malformedResponse(message: string) {
  return new IntegrationHttpError(message, "malformed");
}

export function parseJsonText(value: string, service: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw malformedResponse(`${service} returned malformed JSON.`);
  }
}

export function responseArray(value: unknown, service: string) {
  if (!Array.isArray(value)) {
    throw new IntegrationHttpError(
      `${service} returned an unexpected response shape.`,
      "malformed",
    );
  }
  return value as unknown[];
}

export function responseArrayField(
  value: unknown,
  fields: string[],
  service: string,
) {
  if (Array.isArray(value)) return value as unknown[];
  const record = responseRecord(value, service);
  for (const field of fields) {
    if (Array.isArray(record[field])) return record[field] as unknown[];
  }
  throw new IntegrationHttpError(
    `${service} returned an unexpected response shape.`,
    "malformed",
  );
}

export function stringField(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return null;
}

export function numberField(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = typeof record[key] === "number" ? record[key] : Number(record[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function errorDetail(error: unknown) {
  if (error instanceof IntegrationHttpError || error instanceof IntegrationUnavailableError) {
    return error.message;
  }
  return "Integration health check failed.";
}

export function errorIsReachable(error: unknown) {
  return error instanceof IntegrationHttpError
    && error.kind !== "unreachable"
    && error.kind !== "timeout";
}