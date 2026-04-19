# Calendar AI Agent

## Overview

A conversational AI agent that lets users add appointments to Google Calendar through natural language. Built with a React + Vite frontend (chat UI) and an Express backend with OpenAI GPT-5.2 as the AI brain.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: OpenAI GPT-5.2 via Replit AI Integrations (env: AI_INTEGRATIONS_OPENAI_BASE_URL, AI_INTEGRATIONS_OPENAI_API_KEY)
- **Calendar**: Google Calendar via Replit Connectors SDK (`@replit/connectors-sdk`)

## Architecture

### Frontend (`artifacts/calendar-agent/`)
- React + Vite chat interface
- SSE streaming for real-time AI responses
- Auto-creates a conversation on first load
- Messages rendered with basic markdown support

### Backend (`artifacts/api-server/`)
- `src/routes/openai/` — Conversation management + AI chat with tool calling
- `src/routes/calendar/` — Direct calendar event checking and creation endpoints
- `src/lib/googleCalendar.ts` — Google Calendar client via connectors SDK

### AI Behavior (system prompt in openai route)
1. Extracts appointment info from natural language (title, date, time)
2. Asks follow-up questions if date or time is missing
3. Asks about description after gathering required fields
4. Checks for calendar conflicts before creating events
5. Warns about conflicts and asks user to confirm
6. Supports forceSchedule to bypass conflict check after user confirmation

### Key Files
- `artifacts/api-server/src/routes/openai/index.ts` — Main AI agent with tool calling loop
- `artifacts/api-server/src/lib/googleCalendar.ts` — Calendar API via connectors SDK
- `artifacts/calendar-agent/src/` — Chat UI components

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Integrations

- **OpenAI AI**: Replit AI Integrations (no API key needed, billed to Replit credits)
- **Google Calendar**: Replit Connectors (OAuth2, connection: conn_google-calendar_01KPHTTM03YRD68AATPXFM0KZA)
