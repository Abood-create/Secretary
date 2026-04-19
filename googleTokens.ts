import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const googleTokens = pgTable("google_tokens", {
  id: text("id").primaryKey().default("default"),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export type GoogleToken = typeof googleTokens.$inferSelect;
