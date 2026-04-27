const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_INPUT_CHARS = 6000;
const MAX_RECENT_MESSAGES = 18;

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: number;
  role: ChatRole;
  content: string;
  createdAt: string;
};

type MemoryState = {
  summary: string;
  profile: string[];
  openQuestions: string[];
  nextSteps: string[];
  updatedAt: string | null;
};

type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  AI: AiBinding;
  COACH_SESSIONS: DurableObjectNamespace;
}

const DEFAULT_MEMORY: MemoryState = {
  summary: "No durable session summary yet.",
  profile: [],
  openQuestions: [],
  nextSteps: [],
  updatedAt: null,
};

const SYSTEM_PROMPT = `You are Runbook Mentor, an AI coordinator for software and product work.
Help the user turn loose context into clear decisions, risks, and next actions.

Rules:
- Keep the reply concise, practical, and specific.
- Do not claim you performed external actions.
- Ask at most one focused question when a blocker remains.
- Maintain durable memory across turns.
- Return only valid JSON with this shape:
{
  "reply": "message to show the user",
  "memory": {
    "summary": "short durable summary of the session",
    "profile": ["stable user or project facts"],
    "openQuestions": ["unresolved questions"],
    "nextSteps": ["concrete next actions"]
  }
}
- Keep profile and openQuestions to at most 5 items each.
- Keep nextSteps to at most 6 items.
- Merge duplicate memory items instead of appending repeated facts.`;

export class CoachSession {
  private sql: SqlStorage;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.sql = this.ctx.storage.sql;
    this.initializeSchema();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const action = parts[3];

    if (request.method === "GET" && !action) {
      return json(await this.snapshot());
    }

    if (request.method === "POST" && action === "message") {
      return this.handleMessage(request);
    }

    if (request.method === "POST" && action === "reset") {
      return this.reset();
    }

    return json({ error: "Not found" }, { status: 404 });
  }

  private initializeSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private async handleMessage(request: Request): Promise<Response> {
    let payload: unknown;

    try {
      payload = await request.json();
    } catch {
      return json({ error: "Request body must be valid JSON." }, { status: 400 });
    }

    const input = isRecord(payload) && typeof payload.message === "string" ? payload.message.trim() : "";

    if (!input) {
      return json({ error: "Message is required." }, { status: 400 });
    }

    if (input.length > MAX_INPUT_CHARS) {
      return json({ error: `Message must be ${MAX_INPUT_CHARS} characters or fewer.` }, { status: 413 });
    }

    this.insertMessage("user", input);

    const memory = this.getMemory();
    const recentMessages = this.getMessages(MAX_RECENT_MESSAGES);
    const llmMessages = this.buildPrompt(memory, recentMessages);

    let assistantReply: string;
    let nextMemory: MemoryState;

    try {
      const result = await this.env.AI.run(MODEL, {
        messages: llmMessages,
        max_tokens: 1200,
        temperature: 0.35,
        top_p: 0.9,
        response_format: { type: "json_object" },
      });

      const parsed = parseModelJson(extractText(result));
      assistantReply = normalizeReply(parsed);
      nextMemory = normalizeMemory(isRecord(parsed) ? parsed.memory : undefined, memory, new Date().toISOString());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Workers AI error";
      return json({ error: `Workers AI request failed: ${message}` }, { status: 502 });
    }

    this.insertMessage("assistant", assistantReply);
    this.saveMemory(nextMemory);

    return json(await this.snapshot());
  }

  private async reset(): Promise<Response> {
    this.sql.exec("DELETE FROM messages; DELETE FROM state;");
    return json(await this.snapshot());
  }

  private buildPrompt(memory: MemoryState, recentMessages: ChatMessage[]): LlmMessage[] {
    return [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content: `Existing durable memory JSON:\n${JSON.stringify(memory)}`,
      },
      ...recentMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ];
  }

  private insertMessage(role: ChatRole, content: string): void {
    this.sql.exec(
      "INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)",
      role,
      content,
      new Date().toISOString(),
    );
  }

  private getMessages(limit = MAX_RECENT_MESSAGES): ChatMessage[] {
    const rows = this.sql
      .exec("SELECT id, role, content, created_at AS createdAt FROM messages ORDER BY id DESC LIMIT ?", limit)
      .toArray() as ChatMessage[];

    return rows.reverse();
  }

  private getMemory(): MemoryState {
    const row = this.sql.exec("SELECT value FROM state WHERE key = 'memory'").toArray()[0] as
      | { value: string }
      | undefined;

    if (!row) {
      return { ...DEFAULT_MEMORY };
    }

    try {
      return normalizeMemory(JSON.parse(row.value), DEFAULT_MEMORY);
    } catch {
      return { ...DEFAULT_MEMORY };
    }
  }

  private saveMemory(memory: MemoryState): void {
    this.sql.exec(
      `
        INSERT INTO state (key, value, updated_at)
        VALUES ('memory', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      JSON.stringify(memory),
      new Date().toISOString(),
    );
  }

  private async snapshot(): Promise<{ model: string; messages: ChatMessage[]; memory: MemoryState }> {
    return {
      model: MODEL,
      messages: this.getMessages(80),
      memory: this.getMemory(),
    };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return html(INDEX_HTML);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        app: "cf_ai_runbook_mentor",
        model: MODEL,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      return json({ sessionId: crypto.randomUUID() });
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{8,80})(?:\/(?:message|reset))?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const objectId = env.COACH_SESSIONS.idFromName(sessionId);
      const session = env.COACH_SESSIONS.get(objectId);
      return session.fetch(request);
    }

    return json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function html(markup: string): Response {
  return new Response(markup, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function extractText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (isRecord(result) && typeof result.response === "string") {
    return result.response;
  }

  return JSON.stringify(result);
}

function parseModelJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON.");
  }
}

function normalizeReply(parsed: unknown): string {
  if (isRecord(parsed) && typeof parsed.reply === "string" && parsed.reply.trim()) {
    return trimTo(parsed.reply.trim(), 5000);
  }

  return "I could not format a response for this turn. Please try again with a shorter message.";
}

function normalizeMemory(candidate: unknown, fallback: MemoryState, updatedAt?: string): MemoryState {
  const source = isRecord(candidate) ? candidate : {};
  const openQuestions = source.openQuestions ?? source.open_questions;
  const nextSteps = source.nextSteps ?? source.next_steps;
  const storedUpdatedAt = typeof source.updatedAt === "string" ? source.updatedAt : null;

  return {
    summary: stringField(source.summary, fallback.summary, 900),
    profile: stringList(source.profile, fallback.profile, 5),
    openQuestions: stringList(openQuestions, fallback.openQuestions, 5),
    nextSteps: stringList(nextSteps, fallback.nextSteps, 6),
    updatedAt: updatedAt ?? storedUpdatedAt ?? fallback.updatedAt,
  };
}

function stringField(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.trim() ? trimTo(value.trim(), maxLength) : fallback;
}

function stringList(value: unknown, fallback: string[], maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const seen = new Set<string>();
  const items: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const cleaned = trimTo(item.trim(), 180);
    const key = cleaned.toLowerCase();

    if (!cleaned || seen.has(key)) {
      continue;
    }

    seen.add(key);
    items.push(cleaned);

    if (items.length === maxItems) {
      break;
    }
  }

  return items;
}

function trimTo(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Runbook Mentor</title>
  <style>
    :root {
      color-scheme: light;
      --page: #f4f7f5;
      --panel: #ffffff;
      --ink: #18201c;
      --muted: #5e6b63;
      --line: #d9e1dc;
      --green: #21775b;
      --green-strong: #145c45;
      --blue: #285f8f;
      --amber: #aa6b20;
      --danger: #a83f3f;
      --shadow: 0 18px 45px rgba(31, 48, 40, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, rgba(33, 119, 91, 0.08), rgba(40, 95, 143, 0.04) 32rem),
        var(--page);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }

    button,
    textarea {
      font: inherit;
    }

    .shell {
      width: min(1440px, 100%);
      margin: 0 auto;
      padding: 24px;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 72px;
      margin-bottom: 18px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .mark {
      display: grid;
      place-items: center;
      flex: 0 0 44px;
      width: 44px;
      height: 44px;
      border: 1px solid rgba(33, 119, 91, 0.32);
      border-radius: 8px;
      background: #ffffff;
      color: var(--green-strong);
      font-weight: 800;
      letter-spacing: 0;
      box-shadow: var(--shadow);
    }

    h1,
    h2,
    p {
      margin: 0;
    }

    h1 {
      font-size: 24px;
      line-height: 1.1;
      letter-spacing: 0;
    }

    .session-line {
      margin-top: 5px;
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    .toolbar {
      display: flex;
      gap: 8px;
      flex: 0 0 auto;
    }

    .icon-button {
      display: inline-grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      color: var(--ink);
      cursor: pointer;
      box-shadow: 0 8px 18px rgba(31, 48, 40, 0.06);
    }

    .icon-button:hover {
      border-color: rgba(33, 119, 91, 0.45);
      color: var(--green-strong);
    }

    .icon-button:disabled {
      cursor: wait;
      opacity: 0.6;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(240px, 0.8fr) minmax(360px, 1.6fr) minmax(240px, 0.8fr);
      gap: 16px;
      align-items: stretch;
      min-height: calc(100vh - 132px);
    }

    .panel {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.94);
      box-shadow: var(--shadow);
    }

    .side-panel {
      padding: 18px;
      overflow: auto;
    }

    .panel-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 14px;
    }

    h2 {
      color: #243029;
      font-size: 15px;
      line-height: 1.2;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .model-pill {
      border: 1px solid rgba(40, 95, 143, 0.28);
      border-radius: 999px;
      padding: 4px 8px;
      color: var(--blue);
      background: rgba(40, 95, 143, 0.07);
      font-size: 12px;
      white-space: nowrap;
    }

    .summary {
      margin-bottom: 18px;
      color: #2b342f;
      font-size: 15px;
      white-space: pre-wrap;
    }

    .memory-block {
      margin-top: 18px;
    }

    .memory-block h3 {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    li {
      position: relative;
      padding: 9px 0 9px 18px;
      border-top: 1px solid rgba(217, 225, 220, 0.72);
      color: #26342d;
      font-size: 14px;
    }

    li::before {
      content: "";
      position: absolute;
      top: 17px;
      left: 2px;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--green);
    }

    li.empty-row {
      padding-left: 0;
      color: var(--muted);
    }

    li.empty-row::before {
      display: none;
    }

    .empty {
      color: var(--muted);
      font-size: 14px;
    }

    .chat-panel {
      display: grid;
      grid-template-rows: 1fr auto;
      min-height: 560px;
      overflow: hidden;
    }

    .messages {
      display: flex;
      flex-direction: column;
      gap: 12px;
      overflow: auto;
      padding: 18px;
    }

    .message {
      width: min(84%, 760px);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 13px 14px;
      background: #ffffff;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 15px;
    }

    .message.user {
      align-self: flex-end;
      border-color: rgba(33, 119, 91, 0.28);
      background: rgba(33, 119, 91, 0.08);
    }

    .message.assistant {
      align-self: flex-start;
      border-color: rgba(40, 95, 143, 0.22);
      background: rgba(40, 95, 143, 0.06);
    }

    .message.pending {
      color: var(--muted);
    }

    .composer {
      display: grid;
      grid-template-columns: 1fr 48px;
      gap: 10px;
      border-top: 1px solid var(--line);
      padding: 14px;
      background: rgba(255, 255, 255, 0.9);
    }

    textarea {
      width: 100%;
      min-height: 52px;
      max-height: 180px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 13px 14px;
      color: var(--ink);
      background: #ffffff;
      outline: none;
    }

    textarea:focus {
      border-color: rgba(33, 119, 91, 0.6);
      box-shadow: 0 0 0 3px rgba(33, 119, 91, 0.12);
    }

    .send-button {
      display: grid;
      place-items: center;
      width: 48px;
      height: 52px;
      border: 0;
      border-radius: 8px;
      background: var(--green);
      color: #ffffff;
      cursor: pointer;
    }

    .send-button:hover {
      background: var(--green-strong);
    }

    .send-button:disabled {
      cursor: wait;
      background: #8ba79b;
    }

    .status {
      min-height: 22px;
      margin-top: 12px;
      color: var(--danger);
      font-size: 14px;
    }

    .timestamp {
      display: block;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    @media (max-width: 1060px) {
      .layout {
        grid-template-columns: 1fr;
      }

      .chat-panel {
        min-height: 62vh;
      }
    }

    @media (max-width: 680px) {
      .shell {
        padding: 14px;
      }

      .topbar {
        align-items: flex-start;
      }

      .brand {
        align-items: flex-start;
      }

      h1 {
        font-size: 21px;
      }

      .layout {
        min-height: auto;
      }

      .message {
        width: 100%;
      }

      .composer {
        grid-template-columns: 1fr;
      }

      .send-button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="mark" aria-hidden="true">CF</div>
        <div>
          <h1>Runbook Mentor</h1>
          <p class="session-line">Session <span id="session-id"></span></p>
        </div>
      </div>
      <div class="toolbar">
        <button class="icon-button" id="new-session" type="button" title="New session" aria-label="New session">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
        <button class="icon-button" id="reset-session" type="button" title="Reset memory" aria-label="Reset memory">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </header>

    <main class="layout">
      <aside class="panel side-panel">
        <div class="panel-heading">
          <h2>Memory</h2>
          <span class="model-pill" id="model-pill">Llama</span>
        </div>
        <p class="summary" id="summary"></p>
        <div class="memory-block">
          <h3>Project facts</h3>
          <ul id="profile-list"></ul>
        </div>
        <div class="memory-block">
          <h3>Open questions</h3>
          <ul id="questions-list"></ul>
        </div>
      </aside>

      <section class="panel chat-panel" aria-label="Chat">
        <div class="messages" id="messages"></div>
        <form class="composer" id="chat-form">
          <textarea id="message-input" name="message" rows="2" maxlength="${MAX_INPUT_CHARS}" placeholder="Describe the project, decision, or blocker"></textarea>
          <button class="send-button" id="send-button" type="submit" title="Send" aria-label="Send message">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m5 12 14-7-4 14-3-6-7-1Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
            </svg>
          </button>
        </form>
      </section>

      <aside class="panel side-panel">
        <div class="panel-heading">
          <h2>Next steps</h2>
        </div>
        <ul id="steps-list"></ul>
        <p class="status" id="status" role="status"></p>
      </aside>
    </main>
  </div>

  <script>
    const SESSION_KEY = "cf_ai_runbook_mentor_session";
    const state = {
      sessionId: localStorage.getItem(SESSION_KEY) || crypto.randomUUID(),
      messages: [],
      busy: false
    };

    localStorage.setItem(SESSION_KEY, state.sessionId);

    const els = {
      sessionId: document.querySelector("#session-id"),
      model: document.querySelector("#model-pill"),
      messages: document.querySelector("#messages"),
      summary: document.querySelector("#summary"),
      profile: document.querySelector("#profile-list"),
      questions: document.querySelector("#questions-list"),
      steps: document.querySelector("#steps-list"),
      status: document.querySelector("#status"),
      form: document.querySelector("#chat-form"),
      input: document.querySelector("#message-input"),
      send: document.querySelector("#send-button"),
      reset: document.querySelector("#reset-session"),
      fresh: document.querySelector("#new-session")
    };

    els.sessionId.textContent = state.sessionId;

    els.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = els.input.value.trim();
      if (!message || state.busy) return;

      els.input.value = "";
      setBusy(true);
      setStatus("");
      renderMessages([...state.messages, { role: "user", content: message }, { role: "assistant", content: "Thinking...", pending: true }]);

      try {
        const data = await api("/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message })
        });
        render(data);
      } catch (error) {
        setStatus(error.message);
        await load();
      } finally {
        setBusy(false);
      }
    });

    els.reset.addEventListener("click", async () => {
      if (state.busy) return;
      setBusy(true);
      setStatus("");
      try {
        render(await api("/reset", { method: "POST" }));
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    });

    els.fresh.addEventListener("click", () => {
      state.sessionId = crypto.randomUUID();
      localStorage.setItem(SESSION_KEY, state.sessionId);
      els.sessionId.textContent = state.sessionId;
      setStatus("");
      render({
        model: "Llama",
        messages: [],
        memory: {
          summary: "No durable session summary yet.",
          profile: [],
          openQuestions: [],
          nextSteps: []
        }
      });
      els.input.focus();
    });

    async function load() {
      try {
        render(await api("", { method: "GET" }));
      } catch (error) {
        setStatus(error.message);
      }
    }

    async function api(path, options) {
      const response = await fetch("/api/sessions/" + encodeURIComponent(state.sessionId) + path, options);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Request failed.");
      }
      return data;
    }

    function render(data) {
      els.model.textContent = data.model ? data.model.replace("@cf/meta/", "") : "Llama";
      state.messages = data.messages || [];
      renderMessages(state.messages);
      renderMemory(data.memory || {});
    }

    function renderMessages(messages) {
      els.messages.replaceChildren();

      if (!messages.length) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "Start with a project, decision, or blocker.";
        els.messages.append(empty);
        return;
      }

      for (const message of messages) {
        const item = document.createElement("article");
        item.className = "message " + message.role + (message.pending ? " pending" : "");
        item.textContent = message.content;
        if (message.createdAt) {
          const stamp = document.createElement("time");
          stamp.className = "timestamp";
          stamp.dateTime = message.createdAt;
          stamp.textContent = new Date(message.createdAt).toLocaleString();
          item.append(stamp);
        }
        els.messages.append(item);
      }

      els.messages.scrollTop = els.messages.scrollHeight;
    }

    function renderMemory(memory) {
      els.summary.textContent = memory.summary || "No durable session summary yet.";
      renderList(els.profile, memory.profile);
      renderList(els.questions, memory.openQuestions);
      renderList(els.steps, memory.nextSteps);
    }

    function renderList(target, items) {
      target.replaceChildren();
      const values = Array.isArray(items) ? items : [];

      if (!values.length) {
        const empty = document.createElement("li");
        empty.className = "empty-row";
        empty.textContent = "None yet.";
        target.append(empty);
        return;
      }

      for (const value of values) {
        const li = document.createElement("li");
        li.textContent = value;
        target.append(li);
      }
    }

    function setBusy(value) {
      state.busy = value;
      els.send.disabled = value;
      els.reset.disabled = value;
      els.fresh.disabled = value;
    }

    function setStatus(message) {
      els.status.textContent = message;
    }

    load();
  </script>
</body>
</html>`;
