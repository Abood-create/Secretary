import { useState, useRef, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateOpenaiConversation,
  useGetOpenaiConversation,
  getGetOpenaiConversationQueryKey
} from "@workspace/api-client-react";

export type Message = {
  id: string | number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  isStreaming?: boolean;
};

function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const isNew = params.has("new");
  const convParam = params.get("conv");
  const convId = convParam ? parseInt(convParam, 10) : null;
  return { isNew, convId };
}

function setUrlConversation(id: number) {
  const url = new URL(window.location.href);
  url.searchParams.delete("new");
  url.searchParams.set("conv", String(id));
  window.history.replaceState(null, "", url.toString());
}

export function useChat() {
  const queryClient = useQueryClient();
  const { isNew, convId: urlConvId } = getUrlParams();

  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const initDone = useRef(false);

  const createConversation = useCreateOpenaiConversation();
  const { data: conversation, isLoading: isConversationLoading } = useGetOpenaiConversation(conversationId as number, {
    query: { enabled: !!conversationId }
  });

  useEffect(() => {
    if (initDone.current) return;

    if (isNew) {
      // Always create a fresh conversation when ?new=1 is in the URL
      initDone.current = true;
      createConversation.mutate({ data: { title: "Calendar Assistant" } }, {
        onSuccess: (newConv) => {
          setConversationId(newConv.id);
          setUrlConversation(newConv.id);
          queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
        }
      });
      return;
    }

    if (urlConvId !== null) {
      // Load the conversation specified in the URL
      initDone.current = true;
      setConversationId(urlConvId);
      return;
    }

    // No URL param: always start a fresh conversation
    initDone.current = true;
    createConversation.mutate({ data: { title: "Calendar Assistant" } }, {
      onSuccess: (newConv) => {
        setConversationId(newConv.id);
        setUrlConversation(newConv.id);
      }
    });
  }, [isNew, urlConvId, createConversation.mutate, queryClient]);

  // Load messages when conversation is fetched
  useEffect(() => {
    if (conversation && conversation.messages) {
      const formattedMessages = conversation.messages
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          createdAt: m.createdAt
        }));
      setMessages(formattedMessages);
      setIsReady(true);
    }
  }, [conversation]);

  const sendMessage = useCallback(async (content: string) => {
    if (!conversationId) return;

    const tempUserId = `temp-user-${Date.now()}`;
    const tempAssistantId = `temp-assistant-${Date.now()}`;

    const newUserMsg: Message = {
      id: tempUserId,
      role: "user",
      content,
      createdAt: new Date().toISOString()
    };

    setMessages(prev => [...prev, newUserMsg]);
    setIsTyping(true);

    try {
      const response = await fetch(`/api/openai/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) throw new Error("Failed to send message");

      setIsTyping(false);

      setMessages(prev => [...prev, {
        id: tempAssistantId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        isStreaming: true
      }]);

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No reader available");

      const decoder = new TextDecoder();
      let streamContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            if (!dataStr) continue;

            try {
              const data = JSON.parse(dataStr);
              if (data.done) {
                setMessages(prev => prev.map(m =>
                  m.id === tempAssistantId ? { ...m, isStreaming: false } : m
                ));
                break;
              }

              if (data.content) {
                streamContent += data.content;
                setMessages(prev => prev.map(m =>
                  m.id === tempAssistantId ? { ...m, content: streamContent } : m
                ));
              }
            } catch (e) {
              console.error("Error parsing SSE chunk", e);
            }
          }
        }
      }

      queryClient.invalidateQueries({ queryKey: getGetOpenaiConversationQueryKey(conversationId) });

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Error sending message:", error);
      setIsTyping(false);
      setMessages(prev => [
        ...prev.filter(m => m.id !== tempAssistantId),
        {
          id: `error-${Date.now()}`,
          role: "assistant" as const,
          content: `Error: ${msg}`,
          createdAt: new Date().toISOString(),
        }
      ]);
    }
  }, [conversationId, queryClient]);

  return {
    messages,
    isTyping,
    sendMessage,
    isReady: isReady && !!conversationId
  };
}
