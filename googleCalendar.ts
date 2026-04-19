// Google Calendar integration — hybrid approach:
// 1. Uses Replit Connectors SDK if REPLIT_CONNECTORS_HOSTNAME + REPL_IDENTITY are set
// 2. Falls back to stored OAuth tokens in DB otherwise

import { db } from "@workspace/db";
import { googleTokens } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

export interface GoogleCalendarListResponse {
  items: GoogleCalendarEvent[];
}

export interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  htmlLink?: string;
}

export interface GoogleCalendarEventBody {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
}

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

// ─── Connector path ───────────────────────────────────────────────────────────

export function connectorAvailable(): boolean {
  const ok = !!(process.env.REPLIT_CONNECTORS_HOSTNAME && process.env.REPL_IDENTITY);
  logger.info({ connectorAvailable: ok }, "googleCalendar: connectorAvailable check");
  return ok;
}

async function connectorFetch(
  fullPath: string, // must start with /calendar/v3/...
  options: { method: string; headers?: Record<string, string>; body?: string }
): Promise<Response> {
  logger.info({ path: fullPath, method: options.method }, "googleCalendar: connector request");
  const { ReplitConnectors } = await import("@replit/connectors-sdk");
  const connectors = new ReplitConnectors();
  const res = await connectors.proxy("google-calendar", fullPath, options) as Response;
  logger.info({ path: fullPath, status: res.status }, "googleCalendar: connector response status");
  return res;
}

// ─── Direct token path ────────────────────────────────────────────────────────

async function getStoredToken(): Promise<string> {
  const [token] = await db
    .select()
    .from(googleTokens)
    .where(eq(googleTokens.id, "default"))
    .limit(1);

  if (!token) {
    throw new Error("No OAuth token in DB — user must authenticate via /auth");
  }

  logger.info({
    tokenPrefix: token.accessToken?.slice(0, 20),
    expiresAt: token.expiresAt,
    isExpired: token.expiresAt ? token.expiresAt < new Date() : false,
    hasRefreshToken: !!token.refreshToken,
  }, "googleCalendar: stored token found");

  if (token.expiresAt && token.expiresAt < new Date()) {
    if (!token.refreshToken) throw new Error("Token expired, no refresh token available");
    return refreshStoredToken(token.refreshToken);
  }

  return token.accessToken;
}

async function refreshStoredToken(refreshToken: string): Promise<string> {
  logger.info("googleCalendar: refreshing expired token");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const text = await res.text();
  logger.info({ status: res.status, responseSnippet: text.slice(0, 200) }, "googleCalendar: token refresh result");
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${text}`);

  const data = JSON.parse(text) as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await db
    .update(googleTokens)
    .set({ accessToken: data.access_token, expiresAt, updatedAt: new Date() })
    .where(eq(googleTokens.id, "default"));

  logger.info({ newTokenPrefix: data.access_token.slice(0, 20), expiresAt }, "googleCalendar: token refreshed + saved");
  return data.access_token;
}

async function directFetch(
  subPath: string, // e.g. /calendars/primary/events
  options: { method: string; body?: string; headers?: Record<string, string> }
): Promise<Response> {
  const accessToken = await getStoredToken();
  const fullUrl = `${CALENDAR_BASE}${subPath}`;
  logger.info({ url: fullUrl, method: options.method, tokenPrefix: accessToken.slice(0, 20) }, "googleCalendar: direct fetch");
  const res = await fetch(fullUrl, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  logger.info({ url: fullUrl, status: res.status }, "googleCalendar: direct fetch response");
  return res;
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

export async function runDiagnostics(): Promise<Record<string, unknown>> {
  const isConnector = connectorAvailable();
  const result: Record<string, unknown> = { connectorAvailable: isConnector };

  try {
    const calListPath = "/calendar/v3/users/me/calendarList";
    let res: Response;

    if (isConnector) {
      res = await connectorFetch(calListPath, { method: "GET" });
    } else {
      const accessToken = await getStoredToken();
      result.tokenPrefix = accessToken.slice(0, 20);
      res = await fetch(`${CALENDAR_BASE}/users/me/calendarList`, {
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      });
    }

    const body = await res.text();
    result.calendarListStatus = res.status;
    result.calendarListBody = body.slice(0, 1000);
    logger.info({ diagnostics: result }, "googleCalendar: diagnostics complete");
  } catch (err) {
    result.diagnosticsError = String(err);
    logger.error({ err }, "googleCalendar: diagnostics error");
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function listCalendarEvents(params: {
  timeMin?: string;
  timeMax?: string;
  singleEvents?: boolean;
  orderBy?: string;
}): Promise<GoogleCalendarEvent[]> {
  const query = new URLSearchParams();
  if (params.timeMin) query.set("timeMin", params.timeMin);
  if (params.timeMax) query.set("timeMax", params.timeMax);
  if (params.singleEvents !== undefined) query.set("singleEvents", String(params.singleEvents));
  if (params.orderBy) query.set("orderBy", params.orderBy);
  const qs = query.toString();
  const subPath = `/calendars/primary/events${qs ? `?${qs}` : ""}`;

  let res: Response;
  if (connectorAvailable()) {
    res = await connectorFetch(`/calendar/v3${subPath}`, { method: "GET" });
  } else {
    res = await directFetch(subPath, { method: "GET" });
  }

  const rawBody = await res.text();
  logger.info({ status: res.status, bodySnippet: rawBody.slice(0, 500) }, "googleCalendar: listCalendarEvents result");

  if (!res.ok) {
    throw new Error(`Google Calendar list events failed (${res.status}): ${rawBody}`);
  }

  const data = JSON.parse(rawBody) as GoogleCalendarListResponse;
  return data.items ?? [];
}

export async function createCalendarEvent(body: GoogleCalendarEventBody): Promise<GoogleCalendarEvent> {
  const subPath = "/calendars/primary/events";
  const requestBody = JSON.stringify(body);

  let res: Response;
  if (connectorAvailable()) {
    res = await connectorFetch(`/calendar/v3${subPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });
  } else {
    res = await directFetch(subPath, { method: "POST", body: requestBody });
  }

  const rawBody = await res.text();
  logger.info({
    status: res.status,
    requestBody,
    responseBody: rawBody.slice(0, 1000),
  }, "googleCalendar: createCalendarEvent result");

  if (!res.ok) {
    throw new Error(`Google Calendar create event failed (${res.status}): ${rawBody}`);
  }

  return JSON.parse(rawBody) as GoogleCalendarEvent;
}

export async function updateCalendarEvent(
  eventId: string,
  patch: { summary?: string; description?: string; start?: { dateTime: string; timeZone?: string }; end?: { dateTime: string; timeZone?: string } }
): Promise<GoogleCalendarEvent> {
  const subPath = `/calendars/primary/events/${encodeURIComponent(eventId)}`;
  const requestBody = JSON.stringify(patch);

  let res: Response;
  if (connectorAvailable()) {
    res = await connectorFetch(`/calendar/v3${subPath}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });
  } else {
    res = await directFetch(subPath, { method: "PATCH", body: requestBody });
  }

  const rawBody = await res.text();
  logger.info({ status: res.status, eventId, requestBody, responseSnippet: rawBody.slice(0, 300) }, "googleCalendar: updateCalendarEvent result");

  if (!res.ok) {
    throw new Error(`Google Calendar update event failed (${res.status}): ${rawBody}`);
  }

  return JSON.parse(rawBody) as GoogleCalendarEvent;
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const subPath = `/calendars/primary/events/${encodeURIComponent(eventId)}`;

  let res: Response;
  if (connectorAvailable()) {
    res = await connectorFetch(`/calendar/v3${subPath}`, { method: "DELETE" });
  } else {
    res = await directFetch(subPath, { method: "DELETE" });
  }

  logger.info({ status: res.status, eventId }, "googleCalendar: deleteCalendarEvent result");

  if (!res.ok && res.status !== 204) {
    const rawBody = await res.text();
    throw new Error(`Google Calendar delete event failed (${res.status}): ${rawBody}`);
  }
}
