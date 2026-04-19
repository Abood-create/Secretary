import { Router } from "express";
import { db } from "@workspace/db";
import { conversations, messages } from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  CreateOpenaiConversationBody,
  SendOpenaiMessageBody,
  GetOpenaiConversationParams,
  DeleteOpenaiConversationParams,
  ListOpenaiMessagesParams,
  SendOpenaiMessageParams,
} from "@workspace/api-zod";
import { listCalendarEvents, createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from "../../lib/googleCalendar.js";

const router = Router();

const USER_TZ = "America/Los_Angeles";
const USER_TZ_OFFSET = "-07:00";

function getTodayString() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: USER_TZ,
  });
}

function formatTimePDT(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: USER_TZ,
  });
}

function formatDatePDT(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: USER_TZ,
  });
}

const SYSTEM_PROMPT = () => `You are a helpful Google Calendar assistant. Your job is to help users schedule, view, update, and delete appointments and events.

Today's date is ${getTodayString()}.
The user's timezone is America/Los_Angeles (Pacific Daylight Time, UTC-7). All times the user mentions are in PDT. Always schedule events in Pacific Daylight Time.

Your behavior:
SCHEDULING:
1. When the user mentions an appointment or event to create, extract: title/name, date, time, duration (default 1 hour), and optional description/notes.
2. If the date is missing, ask: "What date would you like to schedule this for?"
3. If the time is missing, ask: "What time would you like to schedule this?"
4. Only ask about description if: (a) this is a standalone new event AND (b) the user has NOT given a clear "go ahead" or "create it" instruction AND (c) it is NOT a replace/swap operation. Skip the description question entirely in replace, delete-and-create, or "go ahead" scenarios.
5. Once you have all required info, use the schedule_event tool with forceSchedule: false.
6. If the tool returns a conflict, tell the user: "There's already an existing event at this time: [event name] from [time] to [time]. Would you like to schedule anyway?"
7. If the user confirms, call schedule_event again with forceSchedule: true.

REPLACE / DELETE-AND-CREATE (most important — do all steps automatically without asking questions):
When the user asks to replace, swap, cancel-and-create, or delete-one-and-add-another, execute this sequence immediately without stopping to ask unnecessary questions:
  Step 1: Call list_events to find the event being removed.
  Step 2: Call delete_event to remove it.
  Step 3: Call schedule_event with forceSchedule: true for the new event (skip conflict check — the old event is gone). Use any description the user mentioned; if none, omit it entirely, do NOT ask.
  Step 4: Respond with a single confirmation: "Done! I've removed [old event] and added [new event] on [date] from [start] to [end]."
Never pause between these steps to ask questions. Do the whole sequence in one turn.

UPDATING:
8. If the user wants to add or change the description (or title, or time) of an event that was ALREADY created, use list_events to find it, then call update_event with the event ID and the new values.
9. After updating, confirm what changed: "Done! I've updated [event name] with the new description."

VIEWING:
10. When the user asks what events they have (today, tomorrow, a specific date, this week, etc.), use the list_events tool and present the results clearly.

DELETING:
11. When the user asks to delete or remove an event (without replacing), first use list_events to find it, then call delete_event. Confirm: "Done! I've deleted [event name] from your calendar."

General:
- Be conversational, warm, and concise.
- Interpret relative dates like "tomorrow", "next Monday", "this Friday" using today's date.
- For durations: if only start time is given, default to 1 hour.
- Never pause mid-sequence to ask questions — complete multi-step operations in one turn.
- When building startDateTime/endDateTime for tools, always include the PDT offset: 2025-04-20T14:00:00-07:00
- Descriptions can be provided at ANY point in the conversation — before, during, or after an event is created. Always use the most recently stated description.
- ERROR HANDLING: If any tool returns a result with "error": true, you MUST show the user the exact error message verbatim. Do not rephrase, soften, or summarize it. Show it exactly as: "Error: [exact message here]"`;

const SCHEDULE_TOOL = {
  type: "function" as const,
  function: {
    name: "schedule_event",
    description: "Schedule a new event on Google Calendar.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The event title/name" },
        startDateTime: { type: "string", description: "Start in ISO 8601 with PDT offset, e.g. 2025-04-20T14:00:00-07:00" },
        endDateTime: { type: "string", description: "End in ISO 8601 with PDT offset, e.g. 2025-04-20T15:00:00-07:00" },
        description: { type: "string", description: "Optional event description or notes" },
        forceSchedule: { type: "boolean", description: "Set to true if user confirmed they want to schedule despite a conflict" },
      },
      required: ["title", "startDateTime", "endDateTime"],
    },
  },
};

const LIST_EVENTS_TOOL = {
  type: "function" as const,
  function: {
    name: "list_events",
    description: "List events from the user's Google Calendar for a given time window. Use this to answer questions like 'what do I have today', 'what's on my schedule tomorrow', or to find an event before deleting it.",
    parameters: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "Start of the window in ISO 8601 with PDT offset, e.g. 2025-04-20T00:00:00-07:00" },
        timeMax: { type: "string", description: "End of the window in ISO 8601 with PDT offset, e.g. 2025-04-20T23:59:59-07:00" },
      },
      required: ["timeMin", "timeMax"],
    },
  },
};

const DELETE_TOOL = {
  type: "function" as const,
  function: {
    name: "delete_event",
    description: "Permanently delete an event from the user's Google Calendar by its event ID. Always call list_events first to find the correct event ID.",
    parameters: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The Google Calendar event ID to delete" },
        eventTitle: { type: "string", description: "The human-readable name of the event being deleted, for confirmation" },
      },
      required: ["eventId", "eventTitle"],
    },
  },
};

const UPDATE_TOOL = {
  type: "function" as const,
  function: {
    name: "update_event",
    description: "Update an existing Google Calendar event — add or change its description, title, or time. Always call list_events first to get the event ID.",
    parameters: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The Google Calendar event ID to update" },
        eventTitle: { type: "string", description: "The human-readable name of the event, for confirmation messaging" },
        description: { type: "string", description: "New description/notes to set on the event" },
        summary: { type: "string", description: "New title/name for the event, if changing it" },
        startDateTime: { type: "string", description: "New start time in ISO 8601 with PDT offset, if changing it" },
        endDateTime: { type: "string", description: "New end time in ISO 8601 with PDT offset, if changing it" },
      },
      required: ["eventId", "eventTitle"],
    },
  },
};

const ALL_TOOLS = [SCHEDULE_TOOL, LIST_EVENTS_TOOL, DELETE_TOOL, UPDATE_TOOL];

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

async function runScheduleTool(args: {
  title: string;
  startDateTime: string;
  endDateTime: string;
  description?: string;
  forceSchedule?: boolean;
}): Promise<string> {
  try {
    const startTime = new Date(args.startDateTime);
    const endTime = new Date(args.endDateTime);

    if (!args.forceSchedule) {
      const existingEvents = await listCalendarEvents({
        timeMin: startTime.toISOString(),
        timeMax: endTime.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const conflicts = (existingEvents ?? []).filter((e) => {
        const eStart = new Date(e.start?.dateTime ?? e.start?.date ?? "");
        const eEnd = new Date(e.end?.dateTime ?? e.end?.date ?? "");
        return eStart < endTime && eEnd > startTime;
      });

      if (conflicts.length > 0) {
        const conflictDetails = conflicts.map((e) => {
          const eStart = e.start?.dateTime ?? e.start?.date ?? "";
          const eEnd = e.end?.dateTime ?? e.end?.date ?? "";
          return `"${e.summary ?? "Untitled"}" from ${formatTimePDT(eStart)} to ${formatTimePDT(eEnd)}`;
        }).join(", ");

        return JSON.stringify({
          conflict: true,
          message: `There's already an existing event at this time: ${conflictDetails}. Ask the user if they want to schedule anyway.`,
        });
      }
    }

    const event = await createCalendarEvent({
      summary: args.title,
      description: args.description,
      start: { dateTime: args.startDateTime, timeZone: USER_TZ },
      end: { dateTime: args.endDateTime, timeZone: USER_TZ },
    });

    return JSON.stringify({
      success: true,
      message: "Event created successfully!",
      eventDetails: {
        title: args.title,
        date: formatDatePDT(args.startDateTime),
        time: `${formatTimePDT(args.startDateTime)} – ${formatTimePDT(args.endDateTime)}`,
        link: event.htmlLink,
      },
    });
  } catch (err: unknown) {
    return JSON.stringify({ error: true, message: err instanceof Error ? err.message : "Calendar error" });
  }
}

async function runListEventsTool(args: { timeMin: string; timeMax: string }): Promise<string> {
  try {
    const events = await listCalendarEvents({
      timeMin: new Date(args.timeMin).toISOString(),
      timeMax: new Date(args.timeMax).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    if (!events || events.length === 0) {
      return JSON.stringify({ success: true, events: [], message: "No events found in this time window." });
    }

    const formatted = events.map((e) => ({
      id: e.id,
      title: e.summary ?? "Untitled",
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      startFormatted: e.start?.dateTime ? formatTimePDT(e.start.dateTime) : (e.start?.date ?? ""),
      endFormatted: e.end?.dateTime ? formatTimePDT(e.end.dateTime) : (e.end?.date ?? ""),
      description: e.description ?? "",
      link: e.htmlLink ?? "",
    }));

    return JSON.stringify({ success: true, events: formatted });
  } catch (err: unknown) {
    return JSON.stringify({ error: true, message: err instanceof Error ? err.message : "Calendar error" });
  }
}

async function runDeleteEventTool(args: { eventId: string; eventTitle: string }): Promise<string> {
  try {
    await deleteCalendarEvent(args.eventId);
    return JSON.stringify({ success: true, message: `Event "${args.eventTitle}" has been deleted.` });
  } catch (err: unknown) {
    return JSON.stringify({ error: true, message: err instanceof Error ? err.message : "Calendar error" });
  }
}

async function runUpdateEventTool(args: {
  eventId: string;
  eventTitle: string;
  description?: string;
  summary?: string;
  startDateTime?: string;
  endDateTime?: string;
}): Promise<string> {
  try {
    const patch: Parameters<typeof updateCalendarEvent>[1] = {};
    if (args.description !== undefined) patch.description = args.description;
    if (args.summary !== undefined) patch.summary = args.summary;
    if (args.startDateTime !== undefined) patch.start = { dateTime: args.startDateTime, timeZone: USER_TZ };
    if (args.endDateTime !== undefined) patch.end = { dateTime: args.endDateTime, timeZone: USER_TZ };

    await updateCalendarEvent(args.eventId, patch);

    const changes: string[] = [];
    if (args.description !== undefined) changes.push("description");
    if (args.summary !== undefined) changes.push("title");
    if (args.startDateTime !== undefined || args.endDateTime !== undefined) changes.push("time");

    return JSON.stringify({
      success: true,
      message: `Event "${args.eventTitle}" updated successfully (${changes.join(", ")}).`,
    });
  } catch (err: unknown) {
    return JSON.stringify({ error: true, message: err instanceof Error ? err.message : "Calendar error" });
  }
}

async function dispatchTool(toolName: string, argsStr: string): Promise<string> {
  const args = JSON.parse(argsStr);
  if (toolName === "schedule_event") return runScheduleTool(args);
  if (toolName === "list_events") return runListEventsTool(args);
  if (toolName === "delete_event") return runDeleteEventTool(args);
  if (toolName === "update_event") return runUpdateEventTool(args);
  return JSON.stringify({ error: true, message: `Unknown tool: ${toolName}` });
}

router.get("/conversations", async (req, res) => {
  const all = await db.select().from(conversations).orderBy(conversations.createdAt);
  res.json(all);
});

router.post("/conversations", async (req, res) => {
  const parsed = CreateOpenaiConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [conv] = await db.insert(conversations).values({ title: parsed.data.title }).returning();
  res.status(201).json(conv);
});

router.get("/conversations/:id", async (req, res) => {
  const { id } = GetOpenaiConversationParams.parse({ id: Number(req.params.id) });
  const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
  if (!conv) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id));
  res.json({ ...conv, messages: msgs });
});

router.delete("/conversations/:id", async (req, res) => {
  const { id } = DeleteOpenaiConversationParams.parse({ id: Number(req.params.id) });
  const deleted = await db.delete(conversations).where(eq(conversations.id, id)).returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

router.get("/conversations/:id/messages", async (req, res) => {
  const { id } = ListOpenaiMessagesParams.parse({ id: Number(req.params.id) });
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id));
  res.json(msgs);
});

router.post("/conversations/:id/messages", async (req, res) => {
  const { id } = SendOpenaiMessageParams.parse({ id: Number(req.params.id) });
  const parsed = SendOpenaiMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { content } = parsed.data;
  await db.insert(messages).values({ conversationId: id, role: "user", content });

  const history = await db.select().from(messages).where(eq(messages.conversationId, id));

  const chatMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT() },
    ...history.map((m) => {
      if (m.role === "assistant_tool_call") {
        const p = JSON.parse(m.content) as { toolCallId: string; toolName?: string; args: string };
        return {
          role: "assistant" as const,
          content: null,
          tool_calls: [{
            id: p.toolCallId,
            type: "function" as const,
            function: { name: p.toolName ?? "schedule_event", arguments: p.args },
          }],
        };
      }
      if (m.role === "tool") {
        const p = JSON.parse(m.content) as { toolCallId: string; result: string };
        return {
          role: "tool" as const,
          content: p.result,
          tool_call_id: p.toolCallId,
        };
      }
      return { role: m.role as "user" | "assistant", content: m.content };
    }),
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let finalAssistantContent = "";

  const runLoop = async (loopMessages: ChatMessage[]): Promise<void> => {
    const stream = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 8192,
      messages: loopMessages,
      tools: ALL_TOOLS,
      stream: true,
    });

    let streamContent = "";
    let toolCallId = "";
    let toolCallName = "";
    let toolCallArgs = "";
    let isToolCall = false;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          isToolCall = true;
          if (tc.id) toolCallId = tc.id;
          if (tc.function?.name) toolCallName = tc.function.name;
          if (tc.function?.arguments) toolCallArgs += tc.function.arguments;
        }
      }

      if (delta?.content) {
        streamContent += delta.content;
        finalAssistantContent += delta.content;
        res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
      }
    }

    if (isToolCall) {
      await db.insert(messages).values({
        conversationId: id,
        role: "assistant_tool_call",
        content: JSON.stringify({ toolCallId, toolName: toolCallName, args: toolCallArgs }),
      });

      const toolResult = await dispatchTool(toolCallName, toolCallArgs);

      await db.insert(messages).values({
        conversationId: id,
        role: "tool",
        content: JSON.stringify({ toolCallId, result: toolResult }),
      });

      const nextMessages: ChatMessage[] = [
        ...loopMessages,
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: toolCallId,
            type: "function",
            function: { name: toolCallName, arguments: toolCallArgs },
          }],
        },
        {
          role: "tool",
          content: toolResult,
          tool_call_id: toolCallId,
        },
      ];

      await runLoop(nextMessages);
    } else if (streamContent) {
      finalAssistantContent = streamContent;
    }
  };

  try {
    await runLoop(chatMessages);

    if (finalAssistantContent) {
      await db.insert(messages).values({
        conversationId: id,
        role: "assistant",
        content: finalAssistantContent,
      });
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errorContent = `Error: ${errorMsg}`;
    res.write(`data: ${JSON.stringify({ content: errorContent })}\n\n`);
    try {
      await db.insert(messages).values({ conversationId: id, role: "assistant", content: errorContent });
    } catch (_) {}
  }

  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
});

export default router;
