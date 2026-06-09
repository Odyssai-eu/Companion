# Hermes — entreprise (serveur) & local (desktop)

Deux façons d'utiliser Hermes (l'agent Nous Research) avec OdyssAI-X + Companion.
Hermes est un **agent personnel** : il a besoin d'accès machine (FS, shell,
outils). D'où deux modèles, pas un bridge maison.

## 1. Entreprise — Hermes partagé sur `.39` (le défaut)

Une seule instance Hermes, **la même pour tout le monde**, embarquée dans
Companion via le dashboard web de Hermes.

```
.39 (hôte partagé)                         Companion (container sur .39)
  hermes dashboard :9119  ◀── iframe ──   /hermes  →  HermesPanel
  modèle = OdyssAI-X (localhost:8000)        (addon "Hermes Agent".bridgeUrl)
  (service launchd, KeepAlive)
```

### Setup (déjà fait sur `.39`)

1. **Installer Hermes** (installeur officiel Nous) :
   ```bash
   curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
   ```
   Binaire → `~/.local/bin/hermes` ; projet → `~/.hermes/hermes-agent`.

2. **Pointer Hermes sur OdyssAI-X** — `~/.hermes/config.yaml` :
   ```yaml
   model:
     default: "minimax-m3"          # modèle qui répond + tient l'agentique
     provider: "custom"
     api_key: "local"
     base_url: "http://localhost:8000/v1"   # OdyssAI-X (loopback sur .39)
   ```
   Valider : `hermes -z "Reply with exactly: ok"` → `ok`. Backup : `config.yaml.bak-odyssai`.
   (Gotcha : `model.default` est LE champ lu. Le 35B-A3B boucle sur l'agentique —
   prendre un modèle costaud. hy3-preview est cloud-proxied OpenRouter.)

3. **Dashboard en service launchd** — `~/Library/LaunchAgents/ai.odyssai.hermes-dashboard.plist`
   (copie dans `infra/hermes-gateway/ai.odyssai.hermes-dashboard.plist`) :
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.odyssai.hermes-dashboard.plist
   ```
   Lance `hermes dashboard --host 0.0.0.0 --insecure --no-open --port 9119 --skip-build`.
   Build de l'UI au préalable (une fois) : `cd ~/.hermes/hermes-agent/web && ~/.hermes/node/bin/npm install && ~/.hermes/node/bin/npm run build`.
   Le dashboard sert en mode **embedded-chat, auth non requise** (token auto-injecté).

4. **Brancher Companion** — l'addon "Hermes Agent" (`bridgeUrl`) :
   - Soit l'opérateur met l'env `HERMES_DASHBOARD_URL=http://<host>:9119` (défaut
     pour tous les users — `addon-hermes.ts` le lit).
   - Soit par-user via Settings → Add-ons → Hermes Agent → bridgeUrl.
   Dans le chat, `/hermes` ouvre alors `HermesPanel` (iframe plein du dashboard).

### ⚠ Mixed-content
L'iframe charge `http://<host>:9119` depuis le navigateur. Si Companion est servi
en **HTTPS**, le navigateur **bloque** un iframe HTTP (mixed-content). Options :
servir Companion en HTTP sur le LAN, OU mettre un proxy same-origin (route
Companion `/hermes-ui/*` → dashboard, à faire si HTTPS requis).

## 2. Local — app desktop Hermes (indépendant de Companion)

Pour Hermes en local sur SA machine, l'utilisateur n'a **pas besoin de Companion** :
1. Installer l'**app desktop Hermes** : https://hermes-agent.nousresearch.com/desktop
2. Dans les settings Hermes, mettre un modèle **OdyssAI-X** (endpoint OpenAI-compat).
3. Ajouter le **MCP Companion** pour l'accès mémoire/skills/conversations.
Companion = juste un endpoint modèle + un serveur MCP. Indépendant.

## Alternative : gateway ACP per-session (non utilisé par le défaut)

`gateway.py` (+ `smoke-test.py`) : un pont **ACP-over-TCP** sur l'hôte. Par
connexion : AUTH token → spawn `hermes acp` → pompe stdio↔socket. Permettrait des
sessions Hermes **isolées par utilisateur** (vs le dashboard partagé). Validé
(ACP `initialize` OK) mais non câblé — l'embed dashboard couvre le besoin
"le même pour tout le monde". À reprendre si on veut du per-user.
