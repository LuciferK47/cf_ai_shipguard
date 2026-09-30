import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from "react";
import type { UIMessage } from "ai";
import { Markdown } from "../Markdown";
import type { ShipGuardApi } from "../useShipGuard";

const MAX = 4000;

function textOf(m: UIMessage): string {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

interface Props {
  api: ShipGuardApi;
  hasAudit: boolean;
}

const SUGGESTIONS_AFTER_AUDIT = [
  "What should I fix first?",
  "What migration issue did you find earlier?",
  "Did we fix the previous findings?"
];

export function Chat({ api, hasAudit }: Props) {
  const { chat, connected } = api;
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const messages = chat.messages;
  const busy = chat.status === "submitted" || chat.status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, chat.status, messages.at(-1)?.parts.length]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy || !connected) return;
    void chat.sendMessage({ text: t });
    setDraft("");
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(draft);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(draft);
    }
  };

  return (
    <>
      <div className="chat-scroll">
        <div className="chat-inner">
          {messages.length === 0 && (
            <div className="empty" style={{ padding: "8px 0" }}>
              <h3>Ask ShipGuard about a Cloudflare project</h3>
              <p>
                Paste a public GitHub URL to audit it, or say “re-audit” to
                check the current project again. Afterwards, ask about any
                finding: answers come from the audits ShipGuard stored, not from
                guesswork.
              </p>
            </div>
          )}

          <ol
            style={{
              display: "contents",
              listStyle: "none",
              margin: 0,
              padding: 0
            }}
            aria-label="Conversation"
          >
            {messages.map((m) => {
              const text = textOf(m);
              if (!text) return null;
              return (
                <li key={m.id} className="msg" data-role={m.role}>
                  <span className="who">
                    {m.role === "user" ? "You" : "ShipGuard"}
                  </span>
                  <div className="body">
                    {m.role === "user" ? (
                      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                        {text}
                      </p>
                    ) : (
                      <Markdown text={text} />
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {busy && messages.at(-1)?.role === "user" && (
            <p className="typing" role="status">
              <span className="pulse">ShipGuard is thinking…</span>
            </p>
          )}
          {chat.status === "error" && (
            <p className="error-text" role="alert">
              Something went wrong sending that message. Your audits are safe;
              try again.
            </p>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <form className="composer" onSubmit={onSubmit}>
        <div className="composer-inner">
          <div style={{ flex: 1 }}>
            {hasAudit && messages.length <= 2 && (
              <div
                className="suggestions"
                style={{ marginBottom: 8 }}
                role="group"
                aria-label="Suggested questions"
              >
                {SUGGESTIONS_AFTER_AUDIT.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="btn btn-small"
                    disabled={busy || !connected}
                    onClick={() => send(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            <label htmlFor="chat-input" className="sr-only">
              Message ShipGuard
            </label>
            <textarea
              id="chat-input"
              className="input"
              rows={2}
              value={draft}
              maxLength={MAX}
              placeholder={
                connected
                  ? "Ask about a finding, paste a repository URL, or type “re-audit”"
                  : "Connecting…"
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              disabled={!connected}
            />
            <p className="hint">
              Enter to send, Shift+Enter for a new line.
              {draft.length > MAX - 300 &&
                ` ${MAX - draft.length} characters left.`}
            </p>
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !connected || draft.trim() === ""}
          >
            Send
          </button>
        </div>
      </form>
    </>
  );
}
