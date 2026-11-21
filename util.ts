// Shared configuration and small deterministic helpers for the forge.
//
// Everything in this module is pure or derived from the process environment at
// startup. The trial's scenario is fixed by the contest (one seed, never
// changed), so the viewer login below is a constant of the contest, with an
// environment override for local runs against a different fixture.
//
// Determinism rules this module keeps for the whole server:
//   - no Date, no Math.random anywhere in request handling;
//   - every timestamp a response carries comes from MAKEFUN_TRIAL_NOW (or a
//     fixed fallback when the variable is absent);
//   - every request id is a counter, never random;
//   - commit timestamps come from a logical clock (trial epoch + counter),
//     so two runs that take the same requests mint the same objects.

import { createHash } from 'node:crypto';

/** The login the trial's bearer token owns (the contest's fixed scenario viewer). */
export const VIEWER_LOGIN: string = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';
/** The viewer's display name and address, as the scenario builds them. */
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The viewer's numeric id, as the scenario builds it. */
export const VIEWER_ID = 1000;

/**
 * The bearer token the trial's clients present. When the variable is absent
 * (a local run) any token is accepted, so the server can be exercised
 * without a trial.
 */
const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** True when `header` is an Authorization header carrying the trial token. */
export function isAuthorized(header: string | undefined): boolean {
  if (SHOP_TOKEN === '') return true;
  if (header === undefined) return false;
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented.length !== SHOP_TOKEN.length) return false;
  // A comparison that does not bail out on the first differing byte.
  let diff = 0;
  for (let i = 0; i < presented.length; i += 1) diff |= presented.charCodeAt(i) ^ SHOP_TOKEN.charCodeAt(i);
  return diff === 0;
}

// -------------------------------------------------------------------------------------------
// Deterministic time
// -------------------------------------------------------------------------------------------

/** Days from 1970-01-01 to the given civil date (Howard Hinnant's algorithm). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parse an ISO-8601 timestamp to epoch seconds without touching Date. */
function parseIsoToEpoch(text: string): number | null {
  const m = ISO_RE.exec(text.trim());
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? '0');
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  let epoch = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second;
  const zone = m[7];
  if (zone !== undefined && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const zh = Number(digits.slice(0, 2));
    const zm = Number(digits.slice(2, 4));
    epoch -= sign * (zh * 3600 + zm * 60);
  }
  return epoch;
}

/** The scenario's day one, 2025-01-01T00:00:00Z, in epoch seconds. */
export const FALLBACK_EPOCH = 1735689600;

/** The trial's opening time, epoch seconds, from MAKEFUN_TRIAL_NOW or the fallback. */
export const TRIAL_EPOCH: number = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const parsed = parseIsoToEpoch(raw);
    if (parsed !== null) return parsed;
  }
  return FALLBACK_EPOCH;
})();

/** Format epoch seconds as an ISO-8601 UTC timestamp, without Date. */
export function isoOfEpoch(epoch: number): string {
  const days = Math.floor(epoch / 86400);
  const secs = epoch - days * 86400;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = month <= 2 ? y + 1 : y;
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const hh = Math.floor(secs / 3600);
  const mm = Math.floor((secs - hh * 3600) / 60);
  const ss = secs - hh * 3600 - mm * 60;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hh)}:${pad(mm)}:${pad(ss)}Z`;
}

/** The one timestamp every API response carries. */
export const TRIAL_NOW_ISO: string = isoOfEpoch(TRIAL_EPOCH);

/**
 * The logical clock for commit objects the server mints (contents API,
 * merges): trial epoch plus a counter, so distinct commits always have
 * distinct timestamps and therefore distinct ids, deterministically.
 */
let commitTick = 0;

/** The next commit timestamp, epoch seconds. */
export function nextCommitEpoch(): number {
  commitTick += 1;
  return TRIAL_EPOCH + commitTick;
}

// -------------------------------------------------------------------------------------------
// Request ids and small value helpers
// -------------------------------------------------------------------------------------------

let requestCounter = 0;

/** A deterministic, non-empty request id for the X-GitHub-Request-Id header. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${String(requestCounter).padStart(8, '0')}`;
}

/** SHA-1 of one or more buffers, as lowercase hex. */
export function sha1Hex(...parts: readonly Uint8Array[]): string {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

/** Decode base64, ignoring the whitespace GitHub wraps it at. */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Encode bytes as standard base64 (no wrapping). */
export function b64encode(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/** Encode text as URL-safe base64 without padding (for opaque global ids). */
export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode URL-safe base64, or null when it does not parse. */
export function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** True for a lowercase 40-hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The all-zero object id. */
export const ZERO_OID = '0'.repeat(40);

// -------------------------------------------------------------------------------------------
// Query and pagination helpers
// -------------------------------------------------------------------------------------------

/** Parse a positive integer query value, falling back to `fallback` when absent or invalid. */
export function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < 1) return fallback;
  return Math.min(i, max);
}

/**
 * Clamp a number into [min, max]; non-finite values become `fallback`.
 * Used for the `first:` argument of GraphQL connections.
 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const i = Math.trunc(value);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

// -------------------------------------------------------------------------------------------
// HTTP plumbing shared by every handler module
// -------------------------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Everything a handler needs for one request. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  /** The HTTP method, defaulting to GET when the request carries none. */
  method: string;
  /** The parsed request URL (absolute, against a dummy base). */
  url: URL;
  /** The request body, fully read (empty for GET/HEAD/DELETE without one). */
  body: Buffer;
  /** The path split on '/', with empty segments dropped. */
  segments: string[];
}

/** The headers every response carries. */
function baseHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'X-GitHub-Request-Id': nextRequestId(),
    Connection: 'keep-alive',
  };
  if (extra !== undefined) Object.assign(headers, extra);
  return headers;
}

/** Send a JSON value with the given status. */
export function sendJson(ctx: Ctx, status: number, value: unknown, extra?: Record<string, string>): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  ctx.res.writeHead(status, baseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    ...extra,
  }));
  ctx.res.end(body);
}

/** Send a pre-serialized JSON buffer with the given status (the read-bench hot path). */
export function sendJsonBuffer(ctx: Ctx, status: number, body: Buffer, extra?: Record<string, string>): void {
  ctx.res.writeHead(status, baseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    ...extra,
  }));
  ctx.res.end(body);
}

/** Send a JSON error body of the shape {"message": ...}. */
export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** Send an empty body (204 and friends). */
export function sendEmpty(ctx: Ctx, status: number, extra?: Record<string, string>): void {
  ctx.res.writeHead(status, baseHeaders({ ...extra }));
  ctx.res.end();
}

/** Send raw bytes with an explicit content type. */
export function sendBytes(
  ctx: Ctx,
  status: number,
  contentType: string,
  body: Buffer,
  extra?: Record<string, string>,
): void {
  ctx.res.writeHead(status, baseHeaders({
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    ...extra,
  }));
  ctx.res.end(body);
}
