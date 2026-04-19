import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { db, googleTokens } from "@workspace/db";
import { eq } from "drizzle-orm";
import { runDiagnostics } from "./lib/googleCalendar.js";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Full diagnostics: connector state, token state, calendarList call
app.get("/api/calendar/diagnostics", async (_req, res) => {
  try {
    const report = await runDiagnostics();
    res.json(report);
  } catch (err) {
    res.json({ error: String(err) });
  }
});

// Reports connector availability and DB token state for diagnostics
app.get("/api/auth/status", async (_req, res) => {
  const connectorAvailable = !!(process.env.REPLIT_CONNECTORS_HOSTNAME && process.env.REPL_IDENTITY);
  const [token] = await db.select().from(googleTokens).where(eq(googleTokens.id, "default")).limit(1);
  const dbTokenPresent = !!token;
  res.json({ connected: connectorAvailable || dbTokenPresent, connectorAvailable, dbTokenPresent });
});

// Start Google OAuth flow (fallback for when connector is unavailable in production)
app.get("/auth", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar",
    access_type: "offline",
    prompt: "consent",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// Handle OAuth callback — exchange code for tokens and save to DB
app.get("/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const error = req.query.error as string | undefined;

  if (error) return res.send(`<h1>OAuth Error</h1><p>${error}</p>`);
  if (!code) return res.send("<h1>Error</h1><p>No authorization code provided.</p>");

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? "",
        grant_type: "authorization_code",
      }),
    });

    const data = await tokenRes.json() as {
      access_token?: string; refresh_token?: string; expires_in?: number; error?: string;
    };

    if (data.error || !data.access_token) {
      return res.send(`<h1>OAuth Error</h1><pre>${JSON.stringify(data, null, 2)}</pre>`);
    }

    const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;

    await db.insert(googleTokens).values({
      id: "default",
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: googleTokens.id,
      set: { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresAt, updatedAt: new Date() },
    });

    res.send(`
      <!DOCTYPE html><html><head><title>Connected</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px">
        <h1>✅ Google Calendar Connected!</h1>
        <p>Your calendar is now linked. Return to the app to start scheduling.</p>
        <a href="/" style="color:#4a7c59">← Back to Calendar Assistant</a>
      </body></html>
    `);
  } catch (err) {
    res.send(`<h1>Token exchange failed</h1><p>${err instanceof Error ? err.message : String(err)}</p>`);
  }
});

export default app;
