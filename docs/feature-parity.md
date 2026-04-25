# Feature parity — ExoScopy → Thecomp.ai

Audit initial Saturday 2026-04-25 sur v0.0.38. **Mis à jour le même jour sur v0.0.45** : la majorité des régressions P0/P1/P2 est livrée.

## Quick status board

| Catégorie | État au 2026-04-25 |
|---|---|
| Markdown rendering | ✅ marked + sanitisation |
| Code blocks export (.md, individual files, .zip) | ✅ |
| Attachments (text/code, images, PDF up to 20p) | ✅ |
| Drag & drop + paste image | ✅ |
| Edit user message | ✅ pencil + Cmd+Enter, server-side truncation |
| Regenerate | ✅ |
| Sidebar search | ✅ |
| Active stream indicator | ✅ pulse vert dans la liste |
| Style presets (Creative/Normal/Code/Custom) | ✅ |
| System prompt library (saved prompts, export/import) | ✅ |
| Detailed stats (prompt/completion/reasoning tokens, chunks, duration) + Copy | ✅ |
| Hold Space push-to-talk | ✅ |
| Global keyboard shortcuts (Cmd+K/N/, ⇧V, Esc) | ✅ |
| Vision/tools capability badges | ✅ heuristique regex |
| Mobile drawer + responsive paddings | ✅ |
| Help page | ✅ (Settings → Reference → Help) |
| Strip markdown avant TTS | ✅ déjà en place |
| TTS Voxtral streaming WAV | ✅ (upgrade vs ExoScopy speechSynthesis) |
| Project view = sidebar identique au chat | ✅ |
| Auto-fill systemPrompt depuis category | ✅ déjà en place dans ProjectPage |
| Cost tracking OpenRouter | 🟡 marker "X tok · cloud" — pas de $ table |
| Web tools (web_search, web_fetch) | 🔴 hors P3 (gros chantier) |
| Magic link / Password reset / OAuth | 🔴 P3 (besoin SMTP / creds) |
| MCP execution | 🔴 P3 (gros chantier) |
| Customisable shortcuts | 🔴 low value, pas prio |
| Cluster monitoring SSH / Model matrix / Download HF | ⚪ Hors scope |

**Légende** :
- ✅ Présent et fonctionnel dans Thecomp.ai
- 🟢 Présent mais avec un écart mineur d'UX
- 🔴 **Régression** — présent dans ExoScopy, absent ou cassé dans Thecomp.ai
- ⚪ Hors scope par décision (cf. `CLAUDE.md` — Thecomp.ai est client-only, pas de cluster ops)

---

## A. Chat & messaging

### Streaming et flux principal

| Feature | État | Notes |
|---|---|---|
| Streaming SSE token-par-token | ✅ | `chat-stream.ts` lit le ReadableStream, parse `data:` lines |
| Stop génération | ✅ | AbortController via `chat.cancel()` |
| Multi-engine dispatch (OpenAI-compat + Anthropic) | ✅ | `engine_kind` sur le serveur |
| Indicateur "thinking" | ✅ | TypingDots pendant le streaming |
| Curseur clignotant à la fin du delta | ✅ | `<span class="animate-pulse bg-cyan">` |
| **Indicateur de tool en cours** | 🔴 | ExoScopy émet `_event: 'tool_start'/'tool_done'` dans le SSE et affiche le nom du tool en train de tourner. Pas de tools dans Thecomp.ai donc N/A pour l'instant. |
| **Multi-turn context preserved** | ✅ | `convoForModel = [...messages, userMsg]` |

### Edit / Regenerate

| Feature | État | Notes |
|---|---|---|
| **Edit message utilisateur** | 🔴 | ExoScopy : double-clic sur un message user → édition inline → tronque l'historique et regénère. Code : `public/index.html:944-964 (handleEdit)`. PUT `/api/conversations/:id` avec messages tronqués. |
| **Regenerate** | 🔴 | Bouton retiré v0.0.37 (était stub). Pas de re-stream depuis le tour précédent. |
| **Branching** | 🔴 | ExoScopy : pas de vrai branching (juste edit + regenerate qui réécrit). À implémenter de la même façon. |

**Choix technique ExoScopy à reprendre** : sur edit, on prend `messages.slice(0, idx)` + le nouveau contenu, on pousse en DB (PUT conversation), puis on relance un streamChat. Pas de tree, juste un linear undo.

### Attachments multimodaux

| Feature | État | Notes |
|---|---|---|
| Texte/code (.txt, .md, .py, etc.) | ✅ | v0.0.38 — embed inline en bloc markdown |
| Image (image/*) | ✅ | v0.0.38 — data URL en multimodal `image_url` |
| PDF jusqu'à 20 pages | ✅ | v0.0.38 — pdf.js, texte + raster PNG par page |
| **Drag & drop sur la zone d'input** | 🔴 | ExoScopy gère `onDragOver` + `onDrop` sur la textarea. À porter dans `Input.tsx`. |
| **Paste image depuis le presse-papier** | 🔴 | ExoScopy : `onPaste` lit `e.clipboardData.items[].getAsFile()`. À ajouter dans `Input.tsx`. |
| **Vision model warning** | 🔴 | ExoScopy avertit si tu attaches une image sur un modèle non-vision (`model.vision === false`). Dépend du metadata models. À ajouter quand on aura le flag `vision` dans `ApiGlobalModel`. |

**Choix technique ExoScopy** : le drop+paste se fait sur la textarea elle-même, pas sur un overlay séparé. `e.preventDefault()` + appelle le même `processFile()` que le file input.

### Rendering

| Feature | État | Notes |
|---|---|---|
| Whitespace preserved (`pre-wrap`) | ✅ | OK pour du texte simple |
| **Markdown → HTML rendering** | 🔴 | **Régression majeure**. ExoScopy utilise `marked.parse(text, {breaks:true, gfm:true})`. Thecomp.ai affiche du markdown brut (les `**`, `##`, ```, etc. apparaissent tels quels). |
| **Tables markdown** | 🔴 | Idem — pas de rendering du tout |
| **Liens cliquables** | 🔴 | Idem |
| **Code blocks stylés** (fond sombre, mono) | 🔴 | Idem — devrait être un `<pre><code class="language-x">` avec syntax highlight |
| **Blockquotes** | 🔴 | Idem |
| **Inline code styling** | 🔴 | Idem |
| **Listes (ordered/unordered)** | 🔴 | Idem |
| **`<think>` blocks → `<details>` collapsible** | 🟢 | Thecomp.ai a un ReasoningBlock séparé qui lit `message.reasoning` (Anthropic-style). ExoScopy parse `<think>...</think>` du contenu. Choix différent mais pas une régression. |
| **Math/LaTeX rendering** | 🔴 | ExoScopy n'a pas KaTeX non plus, donc à vrai dire les deux sont au même niveau. À ajouter si besoin. |
| **Mermaid diagrams** | 🔴 | Pas dans ExoScopy non plus. |

**Choix technique ExoScopy à reprendre** :
- Lib : `marked` (vendor minified, ~30 KB).
- Config : `marked.parse(text, {breaks: true, gfm: true})`.
- Pour `<think>` : regex preprocess avant `marked.parse` qui transforme `<think>X</think>` en `<details class="think-block"><summary>Thinking...</summary><div class="think-content">X</div></details>`.
- Pour les code blocks : juste laisser `marked` produire le `<pre><code class="language-x">` et styler en CSS (Thecomp.ai n'a pas de syntax highlighter ; ExoScopy non plus, juste styling).
- Pour Thecomp.ai stack moderne : utiliser `marked` directement en npm, ou `react-markdown` + `remark-gfm`. Préférence : `marked` (1 dep, plus léger, équivalence fonctionnelle exacte).

### Code block extraction

| Feature | État | Notes |
|---|---|---|
| Extraction en pills `file-N.ext` | ✅ | v0.0.37 — `extractCodeBlocks` |
| Save individuel | ✅ | OK |
| Save all (.zip) | ✅ | OK |
| Filename inferé de la ligne au-dessus | ✅ | OK |

### Copy / Share / Save

| Feature | État | Notes |
|---|---|---|
| Copy to clipboard | ✅ | OK |
| Save response as `.md` | ✅ | v0.0.37 |
| **Copy stats** | 🔴 | ExoScopy : bouton "Copy" sur la stats row qui copie un one-liner JSON-like. Trivial à ajouter. |

### TTS (output vocal)

| Feature | État | Notes |
|---|---|---|
| Bouton Speak/Listen par message | ✅ | OK |
| Stop pendant lecture | ✅ | OK |
| Voice mode (auto-speak) | ✅ | `useVoiceMode` |
| Save WAV | ✅ | OK |
| **Lib** | 🟢 | ExoScopy = `speechSynthesis` browser. Thecomp.ai = mlx-audio VibeVoice (qualité supérieure). C'est un upgrade, pas une régression. |
| **Auto-strip markdown avant lecture** | 🔴 | ExoScopy retire les `**`, `\``, blocs de code, etc. avant la synthèse pour pas que la voix dise "asterisk asterisk". À porter — voir `public/index.html:371-423`. |

**Choix technique ExoScopy** : preprocess regex avant TTS :
```js
text.replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/<[^>]+>/g, '')  // HTML tags
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // markdown links
```

### Voice input (push-to-talk)

| Feature | État | Notes |
|---|---|---|
| Talk button | ✅ | Web Speech API |
| Continuous mode | ✅ | OK |
| **Hold Space to talk** | 🔴 | ExoScopy bind la touche Space en hold. Thecomp.ai : seulement clic Talk. À ajouter (cf. ShortcutsPage qui dit déjà "Space hold-to-talk"). |
| **Auto-send après transcription** | 🟢 | ExoScopy : transcription → ajoute au textarea, l'utilisateur valide. Thecomp.ai : auto-envoie. C'est un choix UX différent, pas une régression. |

### Generation parameters

| Feature | État | Notes |
|---|---|---|
| Temperature, max_tokens, top_p, top_k, min_p, repetition_penalty, seed | ✅ | InferencePanel |
| Thinking + reasoning_effort | ✅ | OK |
| **Web Tools toggle** | 🔴 | ExoScopy a `web_search`, `web_fetch`, `web_fetch_full`. Pas de tools dans Thecomp.ai. |
| Presets Creative/Normal/Code | 🟢 | Dans `STYLE_PRESETS` mais **pas de boutons dans l'UI** — uniquement consommé par `setInference`. À exposer en boutons (cf. `useChat.ts:41-48`). |

### System prompts

| Feature | État | Notes |
|---|---|---|
| Session-level system prompt | ✅ | InferencePanel |
| Toggle on/off | ✅ | `systemPromptEnabled` |
| Project-level override session-level | ✅ | `useChat.ts:259-261` |
| **Save/load named prompts** | 🔴 | ExoScopy permet de sauvegarder N prompts nommés en localStorage et de les charger via dropdown. À ajouter en localStorage `thecompai:systemPrompts` = `[{name, content}, ...]`. |
| **Export/import prompts (.json)** | 🔴 | ExoScopy : download all + upload. Trivial à ajouter une fois la liste en place. |

**Choix technique ExoScopy** : juste un objet JSON en localStorage, pas de DB. Modal avec liste + bouton "Save current" qui demande un nom.

### Stats display

| Feature | État | Notes |
|---|---|---|
| TTFT, tokens, speed | ✅ | StatsRow |
| Cost | 🟢 | Affiché "$0.00 · local" hardcodé. À calculer pour OpenRouter (les modèles ont un prix). |
| **Prompt tokens / Completion tokens séparés** | 🔴 | ExoScopy split prompt vs completion. Thecomp.ai : juste "tokens" total. Source = `usage` dans le SSE final. À étendre `StreamChatResult`. |
| **Generation time / Total time / Chunk count / Chunk rate** | 🔴 | ExoScopy expose tous ces compteurs. À étendre `StreamChatResult` et StatsRow. |

---

## B. Conversations

| Feature | État | Notes |
|---|---|---|
| Liste sidebar groupée Pinned/Today/Yesterday/Older | ✅ | OK |
| Search (filter par titre) | 🔴 | **Régression majeure**. ExoScopy a un input de search au-dessus de la liste qui filtre client-side. Sidebar Thecomp.ai : pas de search. |
| Pin / Unpin | ✅ | OK |
| Rename (double-click) | ✅ | OK |
| Last message preview | ✅ | Subquery `lastMessage` |
| Delete | ✅ | OK |
| Export `.md` | ✅ | OK |
| Export `.json` | ✅ | OK |
| Auto-title depuis 1er message user | ✅ | OK (80 chars) |
| Active stream indicator | 🔴 | ExoScopy : dot animé vert sur la conv en train de stream. Implique de tracker `streamingConvId`. À ajouter (utile quand on changera de conv pendant un stream). |
| **Drag-to-reorder / drag-to-project** | 🔴 | ExoScopy laisse drag une conv vers un projet dans la sidebar. Thecomp.ai : on a un dropdown "Move to project" sur hover, pas de drag. C'est une régression d'ergonomie mais le dropdown existe donc ⚠ mineur. |

---

## C. Projects

| Feature | État | Notes |
|---|---|---|
| Create / Edit / Delete | ✅ | OK |
| Categories (icon + system prompt template) | ✅ | 5 catégories (vs 6 ExoScopy) |
| System prompt par projet | ✅ | OK |
| **Auto-fill systemPrompt depuis category** | 🟢 | ExoScopy : changer la catégorie remplit le systemPrompt si vide ou inchangé. À vérifier dans Thecomp.ai. |
| Export project `.md` | ✅ | OK |
| Project-level system prompt override session | ✅ | OK |
| **"All Chats" filter (montrer seulement les conversations sans projet)** | 🔴 | ExoScopy : `activeProjectId === null` montre seulement les non-assignées. Thecomp.ai : à vérifier. |
| **Instructions field** (séparé du system prompt) | 🟢 | Schéma DB l'a, mais pas certain qu'il soit consommé dans le chat. À vérifier `useChat`. |

---

## D. Engines & servers

| Feature | État | Notes |
|---|---|---|
| Add server | ✅ | OK |
| Multiple servers | ✅ | OK |
| Multiple endpoints par serveur (primary/secondary) | ✅ | OK |
| Test endpoint (latency, healthy) | ✅ | OK |
| Test all endpoints | ✅ | OK |
| Bearer auth | ✅ | OK |
| Engine kinds (openai-compat / anthropic) | ✅ | OK + détection cloud (OpenRouter, Anthropic, OpenAI) |
| OpenRouter quick-add preset | ✅ | OK |
| Model picker avec Local/Cloud toggle | ✅ | OK |
| **Auto-load model on send** (si modèle choisi mais pas chargé sur le cluster) | 🔴 | ExoScopy : si tu envoies avec un modèle pas chargé, il appelle `/api/monitoring/load` et attend. Thecomp.ai : 404 si pas chargé. ⚠ Hors scope si on est client-only (pas de monitoring/load endpoint), à confirmer. |
| **Vision capability badge** | 🔴 | ExoScopy : badge 👁 sur les modèles vision. Thecomp.ai : flag `vision` pas dans le metadata. |
| **Tools capability badge** | 🔴 | Idem — pas tracké côté Thecomp.ai. |
| **Active model badge dans la TopBar** | 🟢 | Thecomp.ai a déjà l'EngineBadge. À vérifier si ça montre le modèle effectivement chargé vs juste sélectionné. |
| **SSH cluster monitoring** (RAM, temp, etc.) | ⚪ | Hors scope. Thecomp.ai est client-only. |
| **Model matrix / Model sync rsync** | ⚪ | Hors scope. |
| **Download queue (HuggingFace catalog)** | ⚪ | Hors scope. |
| **Node discovery** | ⚪ | Hors scope. |

---

## E. Settings

| Feature | État | Notes |
|---|---|---|
| Profile (name, password change) | ✅ | OK |
| Theme (light/dark/system) | ✅ | AppearancePage |
| Servers detail page | ✅ | OK |
| Keyboard shortcuts (référence statique) | ✅ | OK |
| **Customisable shortcuts** | 🔴 | "Coming soon" — pas un blocker |
| Devices page | 🔴 | Stub |
| Accessibility page | 🔴 | Stub |
| Billing | 🔴 | Stub (Stripe pas encore) |
| **Admin mode toggle** | ⚪ | Hors scope (Thecomp.ai = SaaS, pas multi-user self-host) |
| **Guest mode** | ⚪ | Hors scope |
| **OpenRouter API key field** | 🟢 | Géré par bearer auth sur server, donc équivalent. |

---

## F. Auth & users

| Feature | État | Notes |
|---|---|---|
| Email + password signup/login | ✅ | bcryptjs + JWT cookie |
| Logout | ✅ | OK |
| Session persistence | ✅ | httpOnly cookie 30j |
| Profile update (name) | ✅ | OK |
| Change password | ✅ | OK |
| **OAuth Google** | 🔴 | Stub |
| **Magic link** | 🔴 | Stub (besoin SMTP) |
| **Password reset** | 🔴 | Pas implémenté côté Thecomp.ai (ExoScopy non plus, mais c'est un must pour SaaS) |
| **Multi-device sessions** | 🔴 | Stub |
| **2FA** | 🔴 | Pas dans ExoScopy. Pas dans le scope v1 mais à noter. |

---

## G. Add-ons / Plugins

| Feature | État | Notes |
|---|---|---|
| List/Create/Update/Delete addons | ✅ | OK |
| Toggle enable/disable | ✅ | OK |
| **Web Tools (web_search, web_fetch)** | 🔴 | ExoScopy a un système de tools function-calling. Thecomp.ai : rien. À ajouter via la table `addons` (kind=plugin) une fois qu'on a un dispatcher tool. |
| **MCP integration** | 🔴 | Schema existe, CRUD wired, mais pas d'exécution. ExoScopy non plus. |
| **Install from URL** | 🔴 | Stub dans les deux apps |

---

## H. Other

| Feature | État | Notes |
|---|---|---|
| IndicAI / AI Score | ✅ | TopBar + endpoint |
| **Cmd/Ctrl+K → New conversation** | 🔴 | Documenté dans ShortcutsPage mais **pas wiré** (pas de listener global). |
| **Cmd/Ctrl+, → Settings** | 🔴 | Idem documenté mais pas wiré |
| **Cmd/Ctrl+N → New** | 🔴 | Idem |
| **Esc → Stop streaming** | 🔴 | Idem |
| **Cmd/Ctrl+Shift+V → Voice mode** | 🔴 | Idem |
| Enter to send | ✅ | OK |
| Shift+Enter newline | ✅ | OK |
| **Mobile drawer sidebar** | 🔴 | ExoScopy : hamburger + drawer animé. Thecomp.ai : pas vérifié, probablement cassé en mobile (sidebar fixe 280px). |
| **PWA manifest** | 🔴 | Pas confirmé qu'il y a un `manifest.json` |
| **Apple touch icon** | 🟢 | À vérifier |
| **Help modal / Help pages** | 🔴 | Pas de page Help dans Thecomp.ai |

---

## Plan d'action proposé (par ordre de douleur)

### P0 — régressions qui cassent l'UX de base (à faire en priorité)

1. **Markdown rendering** — sans ça, tout le reste ressemble à du texte brut. Lib : `marked` + petit preprocess pour `<think>`.
2. **Search dans la sidebar conversations** — filtre client-side trivial.
3. **Code blocks stylés** — corollaire du markdown rendering, mais dégager un fond sombre + mono pour les `<pre><code>`.
4. **Strip markdown avant TTS** — sinon Voxtral lit "asterisk asterisk".
5. **Drag & drop + paste image** dans la zone d'input — workflow standard, déjà attendu par tout utilisateur.

### P1 — gros confort, peu d'effort

6. **Edit message + regenerate** — workflow clé sur les LLMs. Même sans branching, juste tronquer + restream.
7. **Style presets buttons (Creative / Normal / Code)** — déjà dans le code, juste à exposer.
8. **Save/load system prompts nommés** — pure localStorage.
9. **Hold Space pour talk** — global keydown listener.
10. **Active stream indicator** sur la conv qui stream dans la sidebar.
11. **Stats détaillées** (prompt tokens, completion tokens, chunk rate) — extension de `StreamChatResult`.
12. **Copy stats** — un bouton.

### P2 — features manquantes mais pas critiques

13. **Vision capability badge** — nécessite que l'API exo expose le flag `vision` (déjà le cas, juste à propager).
14. **Cost calculation OpenRouter** — table de prix par modèle, calcul à partir des tokens.
15. **Auto-fill systemPrompt depuis category** lors du changement de category dans le ProjectModal.
16. **Help page** — copier-coller des pages markdown ExoScopy.
17. **Mobile responsive** — drawer hamburger, breakpoint 768px.
18. **Keyboard shortcuts globaux** — handler unique sur `document` qui dispatch.

### P3 — gros chantiers

19. **Tools / function calling** (web_search) — nécessite un tool runner backend + intégration dans `chat.ts`.
20. **Magic link auth + password reset** — nécessite SMTP.
21. **OAuth Google** — nécessite credentials.
22. **MCP integration réelle** — chantier conséquent.
23. **Customisable keybindings** — layer config.

### Hors scope (intentionnel, cf. CLAUDE.md)

- Cluster monitoring SSH
- Model matrix / sync rsync
- Download queue HuggingFace
- Node discovery
- Multi-user self-host (admin mode)
- Guest mode

---

## Notes techniques transverses

**ExoScopy stack** : single-file React JSX in browser, Babel in-browser, vendored libs (`/vendor/`), Express backend, file-based JSON storage, SSH+rsync for cluster ops.

**Thecomp.ai stack** : Vite + React 19 + TS + Tailwind 4, Hono + Drizzle + Postgres, JWT auth.

Pour porter une feature ExoScopy :
- Lire le code dans `/Users/sophie/Claude/code/exoscopy/public/index.html` (UI) ou `server/index.js` (API)
- Adapter à TypeScript / hooks séparés / Tailwind 4
- Pour les libs : `marked`, `jszip`, `pdfjs-dist` ont déjà été migrées en npm (fait pour ExoScopy en vendor, pour Thecomp.ai en npm)

---

*Document à mettre à jour au fur et à mesure de l'implémentation.*
