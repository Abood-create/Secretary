import { Calendar, ExternalLink } from "lucide-react";
import { Message } from "@/hooks/use-chat";
import { cn } from "@/lib/utils";

interface ChatMessageProps {
  message: Message;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";

  // Simple Markdown Parser for bold and links
  const renderContent = (content: string) => {
    if (!content) return null;

    // Detect Google Calendar link format
    const gcalLinkMatch = content.match(/(https:\/\/www\.google\.com\/calendar\/event\?action=VIEW[^ \n]+)/i) || 
                          content.match(/(https:\/\/calendar\.google\.com\/calendar\/[^ \n]+)/i);

    let displayContent = content;
    let linkUrl = null;

    if (gcalLinkMatch) {
      linkUrl = gcalLinkMatch[0];
      displayContent = displayContent.replace(linkUrl, "").trim();
    }

    // Bold parsing
    const parts = displayContent.split(/(\*\*.*?\*\*)/g);

    return (
      <div className="flex flex-col gap-3">
        <div className="whitespace-pre-wrap break-words">
          {parts.map((part, i) => {
            if (part.startsWith('**') && part.endsWith('**')) {
              return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
            }
            return <span key={i}>{part}</span>;
          })}
        </div>
        
        {linkUrl && (
          <a 
            href={linkUrl} 
            target="_blank" 
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-secondary text-secondary-foreground rounded-lg text-sm font-medium hover:bg-secondary/80 transition-colors w-fit border border-border"
          >
            <Calendar className="w-4 h-4 text-primary" />
            View in Google Calendar
            <ExternalLink className="w-3 h-3 ml-1 opacity-50" />
          </a>
        )}
      </div>
    );
  };

  return (
    <div className={cn("flex w-full mb-6", isUser ? "justify-end" : "justify-start")}>
      <div 
        className={cn(
          "max-w-[85%] sm:max-w-[75%] px-5 py-4 rounded-2xl",
          isUser 
            ? "bg-primary text-primary-foreground rounded-br-sm" 
            : "bg-card text-card-foreground shadow-sm border border-card-border rounded-bl-sm"
        )}
      >
        {renderContent(message.content)}
        {message.isStreaming && (
          <span className="inline-block w-1.5 h-4 ml-1 align-middle bg-current animate-pulse opacity-50" />
        )}
      </div>
    </div>
  );
}

export function TypingIndicator() {
  return (
    <div className="flex w-full mb-6 justify-start">
      <div className="bg-card text-card-foreground shadow-sm border border-card-border px-5 py-4 rounded-2xl rounded-bl-sm flex items-center gap-1.5 h-[56px]">
        <div className="w-2 h-2 rounded-full bg-primary/40 animate-bounce [animation-delay:-0.3s]"></div>
        <div className="w-2 h-2 rounded-full bg-primary/40 animate-bounce [animation-delay:-0.15s]"></div>
        <div className="w-2 h-2 rounded-full bg-primary/40 animate-bounce"></div>
      </div>
    </div>
  );
}
