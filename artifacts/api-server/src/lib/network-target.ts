import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

// Shared, provider-neutral network egress guard.
//
// Plex and Jellyfin both accept an operator-supplied server URL, which makes
// them server-side request forgery vectors. The resolution and address
// classification rules live here once so a fix applies to every provider
// instead of drifting between per-provider copies.

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export type ValidatedTarget = { url: URL; address: string; family: 4 | 6 };

export interface TargetErrorFactories {
  /** Operator-correctable problem: configuration, policy, or blocked address. */
  configurationError: (message: string) => Error;
  /** Transport or protocol failure while contacting the provider. */
  requestError: (message: string) => Error;
}

export interface ValidateTargetOptions extends TargetErrorFactories {
  /** Human-facing provider name used in operator messages, e.g. "Plex". */
  label: string;
  /** Current application network mode: offline, local_only, or anything else. */
  networkMode: string;
}

/**
 * Classify a resolved address so the caller can refuse unroutable or
 * policy-violating destinations.
 *
 * `unsafe` covers addresses that must never be contacted (unspecified,
 * link-local, multicast). `local` marks private or loopback space, which the
 * local_only network mode requires.
 */
export function classifyAddress(address: string): { unsafe: boolean; local: boolean } {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return classifyAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const first = octets[0] ?? 0;
    const second = octets[1] ?? 0;
    const unsafe = first === 0 || (first === 169 && second === 254) || first >= 224;
    const local = first === 10
      || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 100 && second >= 64 && second <= 127);
    return { unsafe, local };
  }
  const unsafe = normalized === "::" || normalized.startsWith("fe8") || normalized.startsWith("fe9")
    || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff");
  const local = normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
  return { unsafe, local };
}

/**
 * Normalize an operator-supplied server URL, rejecting non-HTTP schemes and
 * embedded credentials. Returns the trimmed URL without a trailing slash.
 */
export function normalizeServerUrl(
  value: unknown,
  label: string,
  configurationError: (message: string) => Error,
) {
  if (typeof value !== "string" || !value.trim()) return "";
  const candidate = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw configurationError(`Enter a valid ${label} server URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw configurationError(
      `${label} server URL must use HTTP or HTTPS without embedded credentials.`,
    );
  }
  return candidate;
}

/**
 * Resolve a server URL to a concrete address and refuse it when the address or
 * the active network mode forbids contact. Resolving here — and then dialing
 * the resolved literal — keeps the check and the connection consistent.
 */
export async function validateServerTarget(
  serverUrl: string,
  options: ValidateTargetOptions,
): Promise<ValidatedTarget> {
  const { label, networkMode, configurationError, requestError } = options;
  if (networkMode === "offline") {
    throw configurationError(
      `Network mode is offline. Enable local network access before contacting ${label}.`,
    );
  }
  const hostname = new URL(serverUrl).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
      throw requestError(`The ${label} server hostname could not be resolved.`);
    });
  if (!addresses.length) {
    throw requestError(`The ${label} server hostname did not resolve to an address.`);
  }
  const classifications = addresses.map(({ address }) => classifyAddress(address));
  if (classifications.some(({ unsafe }) => unsafe)) {
    throw configurationError(
      `The ${label} server resolved to a blocked link-local, multicast, or unspecified address.`,
    );
  }
  if (networkMode === "local_only" && classifications.some(({ local }) => !local)) {
    throw configurationError(
      `Network mode only permits ${label} servers on local or private addresses.`,
    );
  }
  const selected = addresses[0];
  if (!selected) {
    throw requestError(`The ${label} server hostname did not resolve to an address.`);
  }
  return {
    url: new URL(serverUrl),
    address: selected.address,
    family: isIP(selected.address) as 4 | 6,
  };
}

export interface JsonRequestOptions {
  target: ValidatedTarget;
  /** Absolute path beginning with "/", optionally including a query string. */
  path: string;
  headers: Record<string, string>;
  label: string;
  requestError: (message: string) => Error;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * Issue a bounded GET against an already-validated target and parse JSON.
 *
 * The request dials the resolved address while preserving the original Host
 * header (and TLS servername) so validation cannot be bypassed by a hostname
 * that re-resolves between the check and the connection.
 */
export function requestJson(options: JsonRequestOptions): Promise<unknown> {
  const {
    target,
    path,
    headers,
    label,
    requestError,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = options;
  const relative = new URL(path, "http://provider.local");
  const requestPath = `${target.url.pathname.replace(/\/$/, "")}${relative.pathname}${relative.search}`;
  return new Promise<unknown>((resolve, reject) => {
    const requestOptions = {
      hostname: target.address,
      family: target.family,
      port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
      path: requestPath,
      method: "GET",
      headers: {
        Accept: "application/json",
        Host: target.url.host,
        ...headers,
      },
    };
    const handleResponse = (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let byteCount = 0;
      response.on("data", (chunk: Buffer) => {
        byteCount += chunk.length;
        if (byteCount > maxResponseBytes) {
          response.destroy(
            requestError(
              `${label} returned a response larger than ${Math.round(maxResponseBytes / (1024 * 1024))} MB.`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", (error) => reject(
        error instanceof Error && error.name.endsWith("RequestError")
          ? error
          : requestError(error.message),
      ));
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(requestError(`${label} request failed with HTTP ${response.statusCode ?? 0}.`));
          return;
        }
        const body = Buffer.concat(chunks).toString("utf8");
        // A 204 or an intentionally empty body is a valid "nothing here"
        // answer rather than a malformed payload.
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body) as unknown);
        } catch {
          reject(requestError(`${label} returned an unreadable response.`));
        }
      });
    };
    const request = target.url.protocol === "https:"
      ? httpsRequest({ ...requestOptions, servername: target.url.hostname }, handleResponse)
      : httpRequest(requestOptions, handleResponse);
    request.setTimeout(timeoutMs, () => {
      request.destroy(requestError(`${label} request timed out after ${timeoutMs} ms.`));
    });
    request.on("error", (error) => reject(
      error instanceof Error && error.name.endsWith("RequestError")
        ? error
        : requestError(error.message),
    ));
    request.end();
  });
}
