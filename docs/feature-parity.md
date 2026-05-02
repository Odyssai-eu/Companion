# Feature parity — ExoScopy → Thecomp.ai

Dernière mise à jour : **2026-05-02**, app **v0.1.46**.

But de ce document : savoir ce qui est réellement présent dans le code actuel, ce qui reste stub, et ce qui est volontairement hors scope. L'ancien audit du 2026-04-25 est obsolète : plusieurs régressions rouges ont depuis été livrées.

## Statut court

| Zone | Statut | Notes |
|---|---:|---|
| Chat streaming | ✅ | SSE token-par-token, stop, reasoning, cursor, keepalive backend |
| LiteLLM / EXO direct | ✅ | LiteLLM par défaut, `exo-direct/...` pour A/B latency |
| Conversations | ✅ | CRUD, pin, rename, delete, export, search, grouping, active stream indicator |
| Projects | ✅ | CRUD, categories, system prompt, instructions privées, memory toggle |
| Memory wiki | ✅ | Snapshot par conversation, `Remember now`, toggle projet/conversation, wikilinks strippés |
| Attachments | ✅ | Text/code, image, PDF 20 pages, drag/drop, paste image |
| Rendering | ✅ | Markdown GFM, tables, links, blockquotes, hljs, copy code, `<think>` collapsible |
| TTS / voice | ✅ | Speak/listen, save WAV, voice mode, talk button, hold Space |
| Inference controls | ✅ | temperature, max tokens, top_p/top_k/min_p, rep penalty, seed, thinking |
| Tools add-ons | 🟡 | Backend tool loop présent. Tavily/Hermes/Obsidian existent. UX/config à stabiliser. |
| Auth locale | ✅ | Email/password, JWT cookie, logout, profile/password change |
| OAuth / reset | 🔴 | Pas fait : OAuth, magic link, password reset, 2FA |
| Devices / billing | 🔴 | Pages stub ou absentes côté produit final |
| Admin Extended | 🟡 | Users/nodes/groups/sync/guest tokens codés, mais hors v1 client-only pur |

Légende :
- ✅ présent et buildable
- 🟡 présent mais à valider/stabiliser en runtime
- 🔴 absent/stub
- ⚪ hors scope assumé

## A. Chat & Messaging

| Feature | État | Notes |
|---|---:|---|
| Streaming SSE token-par-token | ✅ | `src/lib/chat-stream.ts`, backend `server/routes/chat.ts` |
| Stop génération | ✅ | `AbortController`, bouton Stop, `Esc` global |
| Keepalive pendant cold start | ✅ | Backend ouvre le SSE immédiatement et envoie `:keepalive` |
| Multi-turn context | ✅ | Historique reconstruit depuis `messages` côté client |
| Time tags | ✅ | Tags `[ISO | Δ: …]` injectés sur chaque user message |
| Reasoning stream | ✅ | `reasoning_content` parsé et rendu dans `ReasoningBlock` |
| Tool lifecycle UI | ✅ | `_event: tool_start/tool_done` parsé et rendu dans `ToolCallsBlock` |
| Edit message user | ✅ | Inline edit, double-click/pencil, truncation serveur puis resend |
| Regenerate | ✅ | Tronque depuis l’assistant message puis relance depuis le dernier user |
| Branching réel | ⚪ | Non repris : ExoScopy était linéaire aussi |

## B. Attachments & Rendering

| Feature | État | Notes |
|---|---:|---|
| Text/code attachments | ✅ | Embed inline en markdown |
| Images | ✅ | Data URL en `image_url` multimodal |
| PDF | ✅ | `pdfjs-dist`, texte + raster, limite 20 pages |
| Drag/drop input | ✅ | `Input.tsx` |
| Paste image/file | ✅ | `Input.tsx` |
| Vision warning | ✅ | Banniere si image + modèle détecté non-vision |
| Markdown GFM | ✅ | `marked`, `breaks`, tables/listes/liens |
| Sanitisation HTML | ✅ | Allowlist custom dans `src/lib/markdown.ts` |
| Syntax highlighting | ✅ | `highlight.js`, langage affiché, copy button |
| Code export | ✅ | Pills, fichier individuel, zip |
| LaTeX / Mermaid | 🔴 | Pas dans ExoScopy non plus. À ajouter uniquement si besoin produit clair. |

## C. Voice, TTS, Stats

| Feature | État | Notes |
|---|---:|---|
| Speak/listen par message | ✅ | `src/lib/tts.ts` |
| Stop lecture | ✅ | OK |
| Save WAV | ✅ | OK |
| Voice mode auto-speak | ✅ | `useVoiceMode` |
| Talk button | ✅ | Web Speech API |
| Hold Space push-to-talk | ✅ | `useGlobalShortcuts` |
| Strip markdown avant TTS | ✅ | `stripMarkdownForTts` |
| TTFT / duration / speed | ✅ | `StatsRow` |
| Prompt/completion/reasoning tokens | ✅ | Usage SSE propagé quand upstream le fournit |
| Chunks | ✅ | Compteur de chunks client |
| Copy stats | ✅ | Bouton `Copy` |
| Cost tracking | ✅ | Table statique modèles cloud + fallback tokens |

## D. Conversations

| Feature | État | Notes |
|---|---:|---|
| Sidebar grouping | ✅ | Pinned / Today / Yesterday / Older |
| Sidebar search | ✅ | Titre + last message |
| All Chats = orphans only | ✅ | `activeProjectId === null` filtre les conversations sans projet |
| Conversation inside project | ✅ | Sidebar limitée au projet actif |
| Pin/unpin | ✅ | OK |
| Rename | ✅ | Double-click |
| Delete | ✅ | OK |
| Export `.md` / `.json` | ✅ | OK |
| Auto-title | ✅ | Depuis premier message user, 80 chars |
| Active stream indicator | ✅ | `streamingConversationId` |
| Drag-to-project | 🟡 | Dropdown move-to-project présent. Pas de DnD ; acceptable pour v1. |

## E. Projects & Memory

| Feature | État | Notes |
|---|---:|---|
| Create/edit/delete project | ✅ | OK |
| Categories + SVG icons | ✅ | Emoji remplacés par slugs + SVG flat |
| Auto-fill system prompt depuis category | ✅ | Présent dans `ProjectPage` |
| System prompt projet | ✅ | Override le prompt session |
| Instructions privées | ✅ | Non envoyées au moteur |
| Export projet `.md` | ✅ | OK |
| Memory toggle projet | ✅ | Défaut pour nouvelles conversations |
| Memory toggle conversation | ✅ | Bouton cerveau dans TopBar |
| Remember now | ✅ | Force snapshot mémoire |
| Memory snapshot stable | ✅ | Préserve le prefix cache EXO |
| Wikilinks Obsidian strippés | ✅ | Côté injection LLM uniquement |

## F. Inference, Models, Tools

| Feature | État | Notes |
|---|---:|---|
| LiteLLM settings | ✅ | URL, API key, default model, timezone |
| Model list | ✅ | `/api/models`, tags/capabilities heuristiques |
| Model picker composer | ✅ | Local/cloud, recherche, capabilities |
| Style presets | ✅ | Creative / Normal / Code / Custom |
| Inference panel | ✅ | Paramètres avancés |
| EXO Direct | ✅ | `exo-direct/<endpointId>/<modelId>` |
| Prewarm conversation | ✅ | 1-token idle warmup pour prefix cache |
| Web tools Tavily | 🟡 | Tool runner présent. À valider avec clé/config runtime. |
| Hermes tools | 🟡 | Add-on + `hermes_quick` / `hermes_deep` présents. Code preflight, write tests, et test execution allowlistés validés via `thecompai-code-runner`. |
| MCP execution | 🔴 | CRUD add-ons existe, pas d’exécution MCP réelle |
| Auto-load model on send | ⚪ | Hors scope client-only ; ce rôle appartient au serveur utilisateur/LiteLLM |

## G. Settings & Auth

| Feature | État | Notes |
|---|---:|---|
| Profile | ✅ | Name + persona/memory profile |
| Password change | ✅ | OK |
| Appearance | ✅ | Theme page |
| Shortcuts reference | ✅ | Cohérent avec `useGlobalShortcuts` |
| Help page | ✅ | Settings → Help |
| Add-ons page | ✅ | CRUD/toggles/config surface |
| Devices page | 🔴 | Stub |
| Accessibility page | 🔴 | Stub |
| Security page | 🔴 | Coming soon |
| Billing | 🔴 | Pas implémenté |
| Email/password auth | ✅ | bcrypt + httpOnly JWT cookie |
| OAuth / magic link / password reset | 🔴 | Besoin SMTP/credentials, pas v0.1 |
| Multi-device sessions | 🔴 | Pas de session/device roster réel |
| 2FA | 🔴 | Pas v1 |

## H. Admin Extended / Guest

| Feature | État | Notes |
|---|---:|---|
| Admin users | 🟡 | API + page admin présentes |
| Nodes/groups | 🟡 | API + schema présents |
| Sync jobs | 🟡 | `sync-runner`, SSH/rsync, live progress |
| Guest tokens | 🟡 | Budget tokens + `/g/:token` + banner |
| License gate | 🟡 | Stub dev bypass / future license server |

Note : ces features contredisent partiellement la ligne “client-only SaaS pur”. Elles existent parce que Thecomp.ai sert aussi de cockpit privé pour Sophie. Pour le produit public v1, les isoler derrière Admin Extended reste la bonne décision.

## Backlog restant

### Bloquant produit

1. **Hermes code UX** — afficher séparément proposal, files written, diff, test logs, et prochain step dans la Code session.
2. **Smoke test runtime complet** — Docker DB + login + LiteLLM + chat + image/PDF + memory + tools.
3. **Billing / entitlement** — minimum viable : plan state + license gate non-stub pour prod.

### Important mais non bloquant chat

4. Devices/session roster.
5. Password reset.
6. OAuth si SaaS public.
7. Add-ons install/import propre.
8. Accessibilité réelle, pas stub.

### Hors scope v1

- Cluster monitoring public
- Model matrix / rsync public
- Download queue HuggingFace
- Node discovery public
- Branching conversation tree
- Custom keybindings
- LaTeX/Mermaid sans demande produit explicite

## Vérification

Dernière vérification locale : `npm run build` OK le 2026-05-02. Déploiement dev `v0.1.46` OK, health check LAN + `dev.thecomp.ai` OK. Test API `run-tests` OK sur `runner-smoke`.
