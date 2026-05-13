import { renderMarkdown } from "~/lib/markdown";

const TOPICS: { id: string; title: string; body: string }[] = [
  {
    id: "getting-started",
    title: "Getting started",
    body: `### What is Companion?

A universal client for AI inference. You bring the engine — local cluster (Odysseus, Ollama, LM Studio, vLLM, MLX), or a cloud key (OpenRouter, Anthropic, OpenAI) — and Companion gives you a single, consistent client across desktop and mobile.

### First steps

1. **Add a server** in *Settings → Servers*. Give it an IP/host + port, plus a bearer token if you're connecting to OpenRouter or Anthropic.
2. **Test the endpoint** to make sure we can reach it. The chip turns green when the handshake works.
3. **Pick a model** in the top bar — Local tab for your cluster, Cloud tab for OpenRouter/Anthropic. The 👁 chip means vision-capable, ⚒ means tools/function calling.
4. **Start typing** — Enter to send, Shift+Enter for a newline.

Conversations and projects sync to your account, so opening Companion on a second device picks up where you left off.`,
  },
  {
    id: "attachments",
    title: "Attachments — text, images, PDFs",
    body: `Click the **paperclip** in the input bar, drag files onto the input, or paste an image from your clipboard.

Supported formats:
- **Text/code**: \`.txt\`, \`.md\`, \`.json\`, \`.py\`, \`.js\`, \`.ts\`, \`.tsx\`, \`.csv\`, \`.yaml\`, \`.toml\`, \`.sh\`, \`.html\`, \`.css\`, \`.xml\`, \`.log\` — read as text and embedded as fenced code blocks in your message.
- **Images** (\`image/*\`): sent as multimodal \`image_url\` parts. Make sure your model is vision-capable (look for the 👁 chip).
- **PDF**: processed in your browser with pdf.js — up to 20 pages. Each page contributes the extracted text plus a rasterised PNG so vision models can read figures, charts, etc.

PDFs that exceed 20 pages are truncated. The chip shows \`Np (of N)\` when truncation happens.`,
  },
  {
    id: "voice",
    title: "Voice — talk and listen",
    body: `### Push-to-talk

Hold **Space** anywhere outside a text input to dictate. Release to send. Uses your browser's Web Speech API; no audio leaves your device for transcription.

### Voice mode (auto-speak replies)

Toggle the speaker icon in the top bar. Replies are streamed through Voxtral-Realtime running on your cluster — first audio plays in <100ms, gapless. Per-message **Listen** / **Stop** controls live in the action row under each assistant reply.

### Saving audio

Each assistant message has a **Save WAV** button that pulls the spoken version as a 24kHz mono WAV.`,
  },
  {
    id: "code",
    title: "Code blocks & exports",
    body: `When the assistant returns fenced code, the response shows:

- **One pill per code block** with the inferred filename. We try the line right above the fence (\`**bench.py**\` style) before falling back to \`file-N.{ext}\`.
- **Save all (.zip)** when there are 2+ blocks.

You can also save the full reply as Markdown via the **Save** button, or export the entire conversation as **\`.md\`** or **\`.json\`** from the conversation menu in the sidebar.`,
  },
  {
    id: "edit-regen",
    title: "Editing and regenerating",
    body: `- **Edit a user message**: hover the bubble → pencil icon, or double-click the text. Cmd+Enter to resend (Esc to cancel). The conversation is truncated server-side — old answers downstream of the edit are removed.
- **Regenerate an answer**: click *Regenerate* under any assistant reply. Same truncation pattern — anything that came after that turn is dropped.

These actions are permanent (we don't keep a branch tree). If you want to compare alternatives, copy the response first.`,
  },
  {
    id: "projects",
    title: "Projects",
    body: `Projects group conversations under a shared **system prompt**. Pick a category (General, Writing, Code, Research, Personal) to start from a preset; edit freely.

A project's system prompt **overrides** the session-level system prompt for any conversation tagged with that project. So the same model behaves like a code reviewer in your *Code* project and a copy editor in your *Writing* project, without you toggling anything.

Move conversations between projects from the conversation menu in the sidebar (hover → project dropdown).`,
  },
  {
    id: "system-prompts",
    title: "System prompts library",
    body: `In the *Inference settings* panel, the **System prompt** section keeps a personal library:

- **Save current** — names the current prompt and stores it.
- **Load saved…** — dropdown to recall.
- **Chips** — click to load, right-click to delete.
- **Export / Import** — JSON dump for backup or sharing across devices.

The library lives in localStorage; it's not synced. Project system prompts are stored server-side and travel with your account.`,
  },
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    body: `| Action | macOS | Windows / Linux |
|---|---|---|
| Focus search | ⌘K | Ctrl+K |
| New conversation | ⌘N | Ctrl+N |
| Open settings | ⌘, | Ctrl+, |
| Toggle voice mode | ⌘⇧V | Ctrl+Shift+V |
| Push-to-talk | hold Space (outside inputs) | hold Space |
| Send message | ⏎ | Enter |
| Newline in input | ⇧⏎ | Shift+Enter |
| Stop streaming | Esc | Esc |`,
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    body: `**"No instance found for model X" / 404 on send**
The selected model isn't loaded on its server. For exo, load it from your cluster's interface; for cloud APIs, double-check the model id and that your bearer token has access.

**OpenRouter shows 0 cloud models**
Make sure the server URL is just \`openrouter.ai\` (no path) and the bearer is your OR API key. We hit \`/api/v1/models\` for OpenRouter specifically.

**TTS doesn't speak**
Voxtral-Realtime needs to be running on the configured TTS server. Check *Settings → Servers* — the TTS health probe is queried on Voice mode toggle.

**Edit/Regenerate doesn't truncate the chat history on reload**
The truncation runs as a fire-and-forget DELETE. If your network drops at the wrong moment, the old turns can stick around in the DB. Re-edit and they'll be wiped on the next attempt.

**Mobile sidebar gets stuck open**
Tap the dimmed backdrop, or press Esc.`,
  },
];

export default function HelpPage() {
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Reference
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          Help.
        </h1>
        <p className="max-w-[640px] text-[15px] leading-[24px] text-gray-600">
          A field guide to the parts of Companion you might not have explored
          yet. The Bear keeps it short.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2">
        {TOPICS.map((t) => (
          <a
            key={t.id}
            href={`#${t.id}`}
            className="rounded-full border border-gray-200 bg-white px-3 py-1 text-[12px] text-gray-600 hover:border-cyan hover:text-navy"
          >
            {t.title}
          </a>
        ))}
      </nav>

      <div className="flex flex-col gap-12">
        {TOPICS.map((t) => (
          <section
            key={t.id}
            id={t.id}
            className="flex flex-col gap-3 scroll-mt-20"
          >
            <h2 className="font-display text-[22px] font-light text-navy">
              {t.title}
            </h2>
            <div
              className="md-body text-[15px] leading-relaxed text-ink"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(t.body) }}
            />
          </section>
        ))}
      </div>
    </div>
  );
}
