import { useEffect, useRef, useState } from "react";
import { useChat } from "@/hooks/use-chat";
import { ChatInput } from "@/components/chat-input";
import { ChatMessage, TypingIndicator } from "@/components/chat-message";
import { Calendar, CheckCircle, AlertCircle, SquarePen } from "lucide-react";

type AuthStatus = "loading" | "connected" | "disconnected";

export default function ChatPage() {
  const { messages, isTyping, sendMessage, isReady } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    fetch("/api/auth/status")
      .then(async (r) => {
        if (!r.ok) {
          console.error("[auth] status returned", r.status);
          setAuthStatus("disconnected");
          return;
        }
        const json = await r.json();
        console.log("[auth] status response:", json);
        setAuthStatus(json.connected === true ? "connected" : "disconnected");
      })
      .catch((err) => {
        console.error("[auth] fetch failed:", err);
        setAuthStatus("disconnected");
      });
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, isTyping]);

  return (
    <div className="flex flex-col h-[100dvh] bg-background">
      {/* Header */}
      <header className="flex-none bg-background/80 backdrop-blur-md border-b border-border p-4 sticky top-0 z-10">
        <div className="flex items-center justify-between max-w-3xl mx-auto w-full">
          {/* Title + New Chat */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                <Calendar className="w-4 h-4 text-primary" />
              </div>
              <h1 className="font-semibold text-foreground text-lg">Abood's Secretary</h1>
            </div>
            <button
              onClick={() => {
                const url = new URL(window.location.href);
                url.searchParams.set("new", "1");
                url.searchParams.delete("conv");
                window.open(url.toString(), "_blank");
              }}
              title="New chat"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted"
            >
              <SquarePen className="w-3.5 h-3.5" />
              New chat
            </button>
          </div>

          {/* Auth Status */}
          {authStatus === "loading" && (
            <span className="text-xs text-muted-foreground animate-pulse">Checking connection…</span>
          )}
          {authStatus === "connected" && (
            <div className="flex items-center gap-1.5 text-sm text-green-700 font-medium">
              <CheckCircle className="w-4 h-4" />
              Calendar connected
            </div>
          )}
          {authStatus === "disconnected" && (
            <a
              href="/auth"
              className="flex items-center gap-1.5 text-sm font-medium bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg transition-colors"
            >
              <AlertCircle className="w-4 h-4" />
              Connect Google Calendar
            </a>
          )}
        </div>
      </header>

      {/* Chat Area */}
      <main className="flex-1 overflow-y-auto" ref={scrollRef}>
        <div className="max-w-3xl mx-auto w-full p-4 sm:p-6 pb-8">

          {/* Welcome Message */}
          <div className="flex w-full mb-6 justify-start">
            <div className="bg-card text-card-foreground shadow-sm border border-card-border px-5 py-4 rounded-2xl rounded-bl-sm max-w-[85%] sm:max-w-[75%]">
              {authStatus === "disconnected"
                ? "Your Google Calendar isn't connected yet. Click \"Connect Google Calendar\" in the top-right to link it, then come back here to start scheduling."
                : "Hi! I'm your Calendar Assistant. Tell me about an appointment or event you'd like to schedule, and I'll add it to your Google Calendar."}
            </div>
          </div>

          {/* Messages */}
          {messages.map((message) => (
            <ChatMessage key={message.id} message={message} />
          ))}

          {/* Typing Indicator */}
          {isTyping && <TypingIndicator />}

        </div>
      </main>

      {/* Input Area */}
      <ChatInput onSend={sendMessage} disabled={!isReady} />
    </div>
  );
}
