"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Source = { title: string; url: string; topic: string | null };
type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

const SUGGESTIONS = [
  "How do I add a custom domain?",
  "How do I set up paid memberships?",
  "Are there transaction fees?",
  "How do I import members?",
];

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || loading) return;

    const nextMessages: Message[] = [
      ...messages,
      { role: "user", content: question },
    ];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    // Placeholder assistant message we stream into.
    setMessages((m) => [...m, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "Request failed");
        throw new Error(errText);
      }

      let sources: Source[] = [];
      const header = res.headers.get("x-sources");
      if (header) {
        try {
          sources = JSON.parse(atob(header));
        } catch {
          /* ignore */
        }
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: acc };
          return copy;
        });
      }

      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content: acc, sources };
        return copy;
      });
    } catch (err: any) {
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: "assistant",
          content: `Something went wrong: ${err.message}`,
        };
        return copy;
      });
    } finally {
      setLoading(false);
    }
  }

  const showEmpty = messages.length === 0;

  return (
    <div className="app">
      <header className="header">
        <div className="logo">G</div>
        <div>
          <h1>Ghost</h1>
          <p>Answers grounded in the Ghost Help Center and Ghost Forum </p>
        </div>
      </header>

      <div className="thread" ref={threadRef}>
        {showEmpty && (
          <div className="empty">
            <h2>Ask anything about Ghost</h2>
            <p>
              I search the Ghost Help Center and community forum, and answer
              with citations to the source articles.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <span className="role">{m.role === "user" ? "You" : "Assistant"}</span>
            <div className="bubble">
              {m.role === "assistant" ? (
                m.content ? (
                  <div className="prose">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {m.content}
                    </ReactMarkdown>
                  </div>
                ) : loading && i === messages.length - 1 ? (
                  <span className="dots">
                    <span /> <span /> <span />
                  </span>
                ) : null
              ) : (
                m.content
              )}
            </div>
            {m.sources && m.sources.length > 0 && (
              <div className="sources">
                <span className="label">Sources</span>
                {m.sources.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                    {s.topic ? ` · ${s.topic}` : ""}
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          value={input}
          placeholder="Ask about setup, memberships, domains, newsletters…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          rows={1}
        />
        <button type="submit" disabled={loading || !input.trim()}>
          {loading ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
