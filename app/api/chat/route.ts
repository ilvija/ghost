import { NextRequest } from "next/server";
import { anthropic } from "@/lib/claude";
import { CHAT_MODEL } from "@/lib/config";
import {
  retrieve,
  buildContext,
  uniqueSources,
  SYSTEM_PROMPT,
} from "@/lib/rag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Msg = { role: "user" | "assistant"; content: string };

export async function POST(req: NextRequest) {
  let body: { messages?: Msg[] };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser?.content?.trim()) {
    return new Response("No question provided", { status: 400 });
  }

  let context = "";
  let sources: ReturnType<typeof uniqueSources> = [];
  try {
    const chunks = await retrieve(lastUser.content);
    context = buildContext(chunks);
    sources = uniqueSources(chunks);
  } catch (err: any) {
    return new Response(`Retrieval error: ${err.message}`, { status: 500 });
  }

  if (!context) {
    const enc = new TextEncoder();
    const noContextStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          enc.encode(
            "I couldn't find anything in the Ghost Help Center for that. Try rephrasing, or ask about setup, memberships, payments, newsletters, domains, or analytics."
          )
        );
        controller.close();
      },
    });
    return new Response(noContextStream, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "x-sources": "" },
    });
  }

  // Keep a short rolling history for follow-up questions.
  // Anthropic requires alternating user/assistant turns — drop any leading assistant turns.
  const rawHistory = messages
    .slice(-6)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // Inject context into the final user turn only (keeps history clean).
  const historyWithoutLast = rawHistory.slice(0, -1);
  const userTurnWithContext = {
    role: "user" as const,
    content: `Question: ${lastUser.content}\n\nContext passages:\n\n${context}`,
  };

  const msgStream = await anthropic().messages.create({
    model: CHAT_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [...historyWithoutLast, userTurnWithContext],
    stream: true,
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of msgStream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
      } catch (err: any) {
        controller.enqueue(encoder.encode(`\n\n[stream error: ${err.message}]`));
      } finally {
        controller.close();
      }
    },
  });

  const sourcesHeader = Buffer.from(JSON.stringify(sources)).toString("base64");
  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "x-sources": sourcesHeader,
      "Cache-Control": "no-store",
    },
  });
}
