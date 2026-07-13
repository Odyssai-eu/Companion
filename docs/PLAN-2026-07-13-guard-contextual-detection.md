# PLAN worker — Confidential Guard V2 : détection contextuelle (DSPy + dsparkqwen), étage 2 du sidecar

**Pour** — agent worker (Sonnet). Tu n'as PAS assisté à la session qui a produit ce plan. Tout ce dont tu as besoin est ici ; si tu dois explorer au-delà ou deviner, c'est le plan qui a échoué, signale-le.

**Repo** — `~/Claude/code/Companion` (le repo Companion, cloné depuis la forge Forgejo `.141`). Le sidecar guard vit dans `infra/guard-service/`.

**Fichiers** (exhaustif — tu ne toucheras qu'à ceux-là) :
- `infra/guard-service/server.py` — MODIFIÉ (ajout étage 2 contextuel)
- `infra/guard-service/contextual.py` — NOUVEAU (programme DSPy : signature + module + load compiled)
- `infra/guard-service/build_dataset.py` — NOUVEAU (génération synthétique du dataset labellisé)
- `infra/guard-service/optimize.py` — NOUVEAU (compilation DSPy MIPROv2 → artefact)
- `infra/guard-service/data/contextual_seed.jsonl` — NOUVEAU (seeds manuels, ~20 exemples)
- `infra/guard-service/data/contextual_train.jsonl` — NOUVEAU (dataset généré, gitignored)
- `infra/guard-service/data/compiled_contextual.json` — NOUVEAU (programme DSPy optimisé, committé)
- `infra/guard-service/com.odyssai.guard.plist` — MODIFIÉ (env vars étage 2)
- `infra/guard-service/README.md` — MODIFIÉ (install + deploy étage 2)
- `infra/guard-service/.gitignore` — NOUVEAU (exclut `data/contextual_train.jsonl`, `.venv`, `__pycache__`)

**Live** — le service tourne sur `admin@192.168.86.44:~/guard-service/` sous launchd (`com.odyssai.guard`, port 8084). Le repo `infra/guard-service/` est la SOURCE ; le déployé se met à jour par scp + relaunch launchd (voir § deploy). **`.44` n'est pas de la prod client** — c'est le host services/RAG. Mais deploy = sur GO seulement (règle ci-dessous).

---

> **Contraintes dures — respecte VERBATIM, elles cassent le fix si violées :**
>
> 1. **INTERDICTION de coder sans GO au tour précédent.** Ce plan EST le GO pour l'implémentation des Work Units (build local + tests locaux). Le **deploy sur `.44` est un GO SÉPARÉ** — ne déploie pas sans que Sophie l'ait dit explicitement au tour d'avant.
> 2. **Zéro URL/host/port hardcodé dans le code**, même en défaut (règle `no_hardcoded_urls`, 2026-07-02). L'endpoint LLM de l'étage 2 se lit dans une **env var** (`GUARD_LLM_BASE`), défaut **vide** → si non configuré, l'étage 2 est désactivé (fail-open silencieux, pas de crash). L'URL réelle vit dans le `.plist` (config de déploiement), jamais dans `server.py`.
> 3. **Fail-open, TOUJOURS.** Une erreur de l'étage 2 (LLM down, timeout, parse KO) ne doit JAMAIS bloquer une classification ni renvoyer une erreur HTTP. En cas d'échec étage 2 → on retombe sur le verdict étage 1 seul. Le guard qui tombe ne doit jamais casser un chat.
> 4. **`no_code_without_go`** : pas d'initiative hors périmètre. Ce qui n'est pas dans les Work Units n'est pas à faire (voir § Non-buts).
> 5. **Commits** : Conventional Commits + HEREDOC + footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Jamais `--no-verify`. Branche courante = `feat/confidential-guard` (NE PAS merger sur main — c'est la décision de Sophie).

---

## Le problème (déjà diagnostiqué — ne pas re-enquêter)

Le guard V0 (déployé, validé) détecte le **PII structurel** via GLiNER2 (`infra/guard-service/server.py:68-90`, endpoint `/guard`). C'est un modèle **NER** : il reconnaît des entités par contexte sémantique appris (IBAN, email, nom, condition médicale, `sk-ant-…`).

**Sa limite, prouvée cette session (faits, pas hypothèse) :** GLiNER2 rate le confidentiel **contextuel / narratif** qui n'est pas une entité nommée :
- secrets d'affaires racontés (« notre client Airbus nous quitte pour Thales, le deal fait 2,4M€ »),
- santé narrative sans terme médical explicite,
- RH / juridique / stratégique non-structuré.

(Il rate aussi les secrets de format arbitraire — clé `sk-8f67…` hex nue, `ghp_…` — mais **Sophie a explicitement décidé de NE PAS traiter ce cas** : pas de couche regex/entropie. Hors périmètre, voir § Non-buts.)

**La V2 = un étage 2 contextuel** : quand l'étage 1 (GLiNER2) est propre, on passe le message à un petit LLM (Qwen3-8B `dsparkqwen`) piloté par DSPy, entraîné à juger « ce message contient-il du confidentiel non-PII ? ». Verdicts fusionnés, même contrat de sortie `/guard` → **zéro changement côté Companion** (l'add-on parle déjà au sidecar).

**Ce qui est ACQUIS (ne pas rouvrir) :**
- Architecture 2-étages (GLiNER stage 1 → contextuel stage 2). Validé avec Sophie.
- Modèle runtime étage 2 = `dsparkqwen` (Qwen3-8B, Telemak local sur `.49`) via `http://192.168.86.39:8000/v1` (OpenAI-compatible), confirmé joignable cette session.
- Dataset = **synthétique** (un gros modèle génère + labellise des exemples fictifs) + une poignée de seeds manuels. Décidé avec Sophie. Pas de vraies données (pas de fuite).
- DSPy pour la signature + l'optimisation (MIPROv2). Explicitement demandé par Sophie.

**Ce qui reste un VRAI inconnu (honnêteté — ce n'est pas un fix mécanique garanti) :** la QUALITÉ de classification du 8B sur le contextuel n'est pas prouvée d'avance. Tu construis le pipeline mécaniquement ; la mesure de qualité (§ Objectif) est le juge. Si la qualité est mauvaise après optimisation, c'est une décision de coordination (remonter à Sophie), pas un échec worker. Ne « bricole » pas pour gonfler un score.

---

## Objectif (done = ces vérités observables)

1. `POST /guard` accepte un flag `contextual: true` (défaut `false` pour compat) ; quand `true` ET l'étage 1 est propre, l'étage 2 tourne et peut flagger un message contextuel.
2. Sur le jeu de test tenu à part (`data/contextual_seed.jsonl` non vu à l'optim, voir WU1), l'étage 2 atteint **≥ 0,8 de F1** sur la classe « sensible contextuel » (précision ET rappel reportés — pas juste l'accuracy, le jeu est déséquilibré).
3. Latence étage 2 mesurée et reportée (attendu : 1-4 s pour un 8B single-node Telemak, thinking OFF). Si > 5 s, le signaler (§ Piège latence).
4. Fail-open vérifié : LLM injoignable → `/guard` répond quand même (verdict étage 1 seul), jamais un 5xx.

**Vérif** (local, sans deploy) :
```bash
# étage 2 flag un secret d'affaires que GLiNER rate :
curl -s -X POST http://localhost:8084/guard -H 'Content-Type: application/json' \
  -d '{"text":"On perd le client Airbus, il signe chez Thales la semaine prochaine pour 2,4M.","contextual":true}' \
  | python3 -m json.tool
# attendu : sensitive=true, une finding catégorie ~"business_secret"

# négatif — message banal ne flag pas :
curl -s -X POST http://localhost:8084/guard -H 'Content-Type: application/json' \
  -d '{"text":"Explique-moi les monades en Haskell.","contextual":true}' \
  | python3 -m json.tool
# attendu : sensitive=false

# fail-open — LLM injoignable (env GUARD_LLM_BASE pointant un port mort) :
GUARD_LLM_BASE=http://127.0.0.1:1/v1 ...  # relance, puis le même curl contextual=true
# attendu : HTTP 200, sensitive=false (retombe sur étage 1), PAS de 5xx
```

---

## Contexte code (lu le 2026-07-13, lignes indicatives — REVÉRIFIE-les avant d'éditer)

`infra/guard-service/server.py` (91 lignes au moment de la lecture) :
- `L12` : `MODEL_ID = os.environ.get("GUARD_MODEL", "fastino/gliner2-privacy-filter-PII-multi")` — pattern env-var-avec-défaut à imiter pour l'étage 2.
- `L16-32` : `CATEGORIES` dict (catégorie PII → sévérité). L'étage 2 ajoute SES catégories contextuelles séparément (ne pas polluer ce dict PII).
- `L34-45` : `app = FastAPI(...)`, `get_model()` lazy-load GLiNER2 sous lock. Imiter le même lazy-load pour le programme DSPy (charge lourde une seule fois, thread-safe).
- `L48-50` : `GuardRequest(BaseModel)` — `text`, `threshold`. **Ajouter `contextual: bool = False`.**
- `L53-57` : `GuardResponse(BaseModel)` — `sensitive`, `max_severity`, `findings`, `latency_ms`. **Ne pas changer la forme** (Companion en dépend) ; l'étage 2 ajoute des `findings` de la même forme `{category, severity, spans}`.
- `L60` : `SEV_ORDER` dict.
- `L68-90` : `guard()` — c'est là que l'étage 2 s'insère, APRÈS le calcul étage 1, AVANT le `return`.

`infra/guard-service/com.odyssai.guard.plist` (déployé sur `.44` à `~/Library/LaunchAgents/`) :
- Bloc `EnvironmentVariables` contient `PATH`, `VIRTUAL_ENV`, `HF_HUB_OFFLINE=1`. **Ajouter `GUARD_LLM_BASE` + `GUARD_LLM_MODEL` ici** (config de déploiement, pas dans le code).
- **Piège `HF_HUB_OFFLINE=1`** : présent pour que GLiNER ne fetch pas au boot. DSPy/openai appellent `.39` en HTTP (pas HF) → OK. Mais si DSPy tente un download HF quelconque, ça planterait ; garde les imports DSPy propres (pas de modèle HF côté DSPy).

`dsparkqwen` via `http://192.168.86.39:8000/v1` — **REVÉRIFIE joignable** avant WU2 :
```bash
curl -s -m 20 -X POST http://192.168.86.39:8000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"dsparkqwen","messages":[{"role":"user","content":"dis OK"}],"max_tokens":10,"temperature":0,"enable_thinking":false}'
```

---

## Work units

### WU1 — Dataset synthétique + seeds

Objectif : produire `data/contextual_train.jsonl` (généré, ~300-400 lignes) et `data/contextual_seed.jsonl` (manuel, ~20 lignes, JEU DE TEST tenu à part, JAMAIS vu à l'optim).

Format d'une ligne (JSONL) :
```json
{"text": "...", "label": "sensitive|clean", "category": "business_secret|health_narrative|hr|legal|strategy|none", "why": "courte raison"}
```

Catégories contextuelles cibles (sévérité toutes `high` au runtime — c'est du confidentiel) :
`business_secret`, `health_narrative`, `hr_personal`, `legal_confidential`, `strategy_internal`. Plus la classe négative `none`.

Étapes :
1. Écris `data/contextual_seed.jsonl` À LA MAIN : ~20 exemples, moitié `sensitive` (un par catégorie, variés), moitié `clean` (code, questions générales, small talk, demandes créatives). C'est le jeu de TEST — il ne sert QU'À mesurer, jamais à optimiser.
2. Écris `build_dataset.py` : appelle un **gros modèle** sur `http://192.168.86.39:8000/v1` (paramétrable via `--generator`, défaut `MI:Minimax3` — c'est du synthétique fictif, un modèle cloud est acceptable) pour générer ~350 exemples équilibrés (≈50% sensitive répartis sur les 5 catégories, ≈50% clean/négatifs durs : messages qui PARLENT de business/santé sans être confidentiels — « explique-moi ce qu'est un IBAN », « comment fonctionne l'assurance maladie »). Prompt de génération : demande des paires réalistes FR + quelques EN, format JSONL strict, une catégorie par exemple. Dé-duplique. Écris dans `data/contextual_train.jsonl`.
   - **Piège génération** : le modèle générateur peut dériver (tout mettre en `sensitive`, ou produire du JSON invalide). Valide chaque ligne (json.loads + champs requis), jette les malformées, logge combien jetées. Vise l'équilibre : si < 30% de `clean`, relance avec un prompt qui insiste sur les négatifs durs.
   - **Piège thinking** : passe `enable_thinking: false` dans le body (sinon `<think>…</think>` pollue la sortie — voir Piège global WU2).
3. **Pourquoi ça suffit** : 350 exemples est le bas de la fourchette DSPy MIPROv2 utile (100-300 démos). On n'a pas besoin de milliers — DSPy optimise le prompt/les démos, pas des poids. Si la qualité plafonne (§ Objectif #2), le levier c'est la DIVERSITÉ des exemples, pas le volume.

**Ne touche pas à** : l'audit-log Companion (hors-cible, PII only). Pas de vraies données utilisateur dans le dataset.

### WU2 — Programme DSPy (signature + module)

Écris `infra/guard-service/contextual.py`.

1. Dépendances : `uv pip install --python .venv/bin/python dspy openai`. (DSPy tire `openai` comme client LLM.)
2. Configure le LM DSPy depuis l'env (règle no-hardcode) :
```python
import os, dspy
_BASE = os.environ.get("GUARD_LLM_BASE", "")   # vide = étage 2 OFF
_MODEL = os.environ.get("GUARD_LLM_MODEL", "dsparkqwen")

def _make_lm():
    if not _BASE:
        return None
    # thinking OFF via extra_body — dsparkqwen (Qwen3) émet <think>…</think> sinon.
    return dspy.LM(
        f"openai/{_MODEL}", api_base=_BASE, api_key="x",
        temperature=0.0, max_tokens=512,
        extra_body={"enable_thinking": False},
    )
```
3. Signature DSPy :
```python
class ContextualConfidential(dspy.Signature):
    """Juge si un message contient de l'information CONFIDENTIELLE contextuelle
    (secret d'affaires, santé narrative, RH, juridique, stratégie interne) —
    au-delà du PII structurel déjà couvert ailleurs. Réponds en français."""
    message: str = dspy.InputField()
    sensitive: bool = dspy.OutputField(desc="true si confidentiel contextuel")
    category: str = dspy.OutputField(desc="business_secret|health_narrative|hr_personal|legal_confidential|strategy_internal|none")
    spans: list[str] = dspy.OutputField(desc="extraits exacts qui justifient, [] si clean")
    why: str = dspy.OutputField(desc="raison courte")
```
4. Module = `dspy.Predict(ContextualConfidential)` (ou `dspy.ChainOfThought` si la qualité l'exige — MAIS CoT rallonge la latence ; commence par `Predict`).
5. Fonction `load_program()` : lazy-load thread-safe (comme `get_model()` server.py:39-45), charge l'artefact compilé `data/compiled_contextual.json` s'il existe (`prog.load(path)`), sinon le module nu. Retourne `None` si `_make_lm()` est None (étage 2 désactivé).
6. Fonction `classify(text) -> dict | None` : configure `dspy.settings.configure(lm=...)` (une fois), appelle le programme, mappe vers `{category, severity:"high", spans}`. **Try/except tout** → retourne `None` sur toute erreur (fail-open, contrainte #3).

**Piège thinking (LE piège central)** : `dsparkqwen` = Qwen3, thinking ON par défaut → il préfixe `<think>raisonnement…</think>` avant la réponse. Vérifié cette session. Deux protections, mets LES DEUX : (a) `extra_body={"enable_thinking": False}` dans le LM ; (b) si malgré ça un `<think>…</think>` apparaît dans un champ de sortie, strippe-le avant parse (regex `re.sub(r"<think>.*?</think>", "", s, flags=re.DOTALL)`). Ne fais pas confiance à (a) seul — selon la version d'engine le flag peut être ignoré (cf lot de bugs thinking dans la stack).

**Piège DSPy + JSON** : DSPy attend une sortie structurée. Un 8B peut renvoyer du texte hors-format → DSPy lève. C'est OK (le try/except du point 6 → fail-open), mais mesure le taux d'échec de parse ; s'il est élevé (> 10%), c'est que le prompt/format est trop dur pour le 8B → simplifie la signature (moins de champs, `sensitive` + `category` seulement, drop `spans`/`why`).

### WU3 — Optimisation DSPy (MIPROv2)

Écris `infra/guard-service/optimize.py`.

1. Charge `data/contextual_train.jsonl` → `dspy.Example(message=..., sensitive=..., category=...).with_inputs("message")`. Split train/val (ex. 80/20) DANS le train — le `seed.jsonl` reste hors-optim (jeu de test final).
2. Métrique : F1 sur `sensitive` (ou exact-match sur `sensitive` bool ; catégorie en bonus). Définis une fonction `metric(example, pred, trace=None) -> bool`.
3. `dspy.MIPROv2(metric=..., auto="light")` (mode light = moins d'appels LLM, suffisant pour un premier tour). `compiled = optimizer.compile(program, trainset=..., valset=...)`.
4. `compiled.save("data/compiled_contextual.json")`.
5. Évalue le compilé sur `seed.jsonl` (jeu de test tenu) → **imprime précision, rappel, F1** sur la classe sensitive. C'est le chiffre de l'Objectif #2.
6. **Piège coût/temps** : MIPROv2 fait beaucoup d'appels LLM. Sur un 8B Telemak single-node, une passe `auto="light"` peut prendre 10-30 min. C'est normal, laisse tourner. Si `auto="medium"` : bien plus long — reste sur `light` pour le premier tour.
7. **Piège data leak** : le `seed.jsonl` (test) ne doit JAMAIS entrer dans `trainset` ni `valset`. Sinon le F1 est bidon. Garde-les physiquement séparés.

**Pourquoi ça suffit** : un tour MIPROv2 light + un jeu de test honnête donne un signal exploitable (ça marche / ça plafonne). On n'itère pas 10 fois à l'aveugle — on mesure, on remonte le chiffre à Sophie, elle décide (garder / élargir le dataset / passer à un LoRA fine-tune = la V3 déjà envisagée).

### WU4 — Intégration étage 2 dans `server.py`

1. `GuardRequest` : ajoute `contextual: bool = False`.
2. Dans `guard()`, APRÈS le calcul étage 1 (server.py:73-84) et AVANT le `return` (L85) :
```python
# Étage 2 — contextuel. Ne tourne QUE si demandé ET étage 1 propre (pas la
# peine de payer la latence LLM si le PII a déjà flagué). Fail-open total.
if req.contextual and not sensitive:
    from contextual import classify   # import local → pas de charge si OFF
    ctx = classify(req.text)          # None si étage 2 OFF ou erreur
    if ctx and ctx.get("sensitive"):
        findings.append({"category": ctx["category"], "severity": "high", "spans": ctx.get("spans", [])})
        max_sev = "high"
        sensitive = True
```
   - **Piège ordre** : l'étage 2 tourne seulement si `not sensitive` (étage 1 propre). Si GLiNER a déjà flagué, on ne paie pas le LLM. C'est l'optimisation de latence clé.
   - **Piège latence par message** : quand `contextual:true`, TOUT message non-PII paie la latence étage 2 (1-4 s). C'est un coût UX réel côté Companion (chaque envoi propre attend le 8B). NE le règle PAS ici (c'est côté Companion, hors périmètre) — mais **documente-le** dans le README et signale-le à Sophie : elle voudra peut-être un flag pour n'activer `contextual` que sur certains profils/conversations. Pour ce plan, le flag `contextual` par requête suffit ; Companion l'enverra ou pas (décision produit ultérieure, PAS toi).
3. `/health` : ajoute un champ `contextual_ready: bool` (= `GUARD_LLM_BASE` non vide).

**Ne touche pas à** : l'étage 1 GLiNER (server.py:70-84 inchangé), la forme de `GuardResponse`, le contrat `/guard` existant (Companion en dépend, un `contextual` absent = comportement V0 identique).

### WU5 — plist, README, .gitignore

1. `com.odyssai.guard.plist` : dans `EnvironmentVariables`, ajoute
   `<key>GUARD_LLM_BASE</key><string>http://192.168.86.39:8000/v1</string>` et
   `<key>GUARD_LLM_MODEL</key><string>dsparkqwen</string>`.
   (L'URL est ici, PAS dans server.py — respect no-hardcode.)
2. `README.md` : section « Stage 2 — contextual » : `uv pip install dspy openai`, comment builder le dataset (`python build_dataset.py`), optimiser (`python optimize.py`), les env vars, le flag `contextual`, et la NOTE latence (WU4 piège).
3. `.gitignore` (nouveau, dans `infra/guard-service/`) : `.venv/`, `__pycache__/`, `data/contextual_train.jsonl` (le dataset généré est reproductible, on committe le seed + le compilé, pas le train volumineux). **Committe** `data/contextual_seed.jsonl` et `data/compiled_contextual.json` (artefacts nécessaires au service).

---

## Non-buts (ne pas faire)

- **PAS de couche regex/entropie pour les secrets** (clés API, tokens). Sophie l'a explicitement écartée cette session. Hors périmètre V2.
- **PAS de changement côté Companion** (`server/`, `src/`). Le flag `contextual` sera câblé côté Companion dans une itération SÉPARÉE (décision produit : quand activer l'étage 2, quels profils). Ce plan s'arrête au sidecar.
- **PAS de merge sur `main`**, pas de deploy prod `.39`. Reste sur la branche `feat/confidential-guard`.
- **PAS de LoRA / fine-tuning de poids** (c'est la V3 envisagée, seulement si la V2 DSPy plafonne). Ici on optimise le PROMPT via DSPy, pas des poids.
- **PAS d'élargissement du dict `CATEGORIES` PII** (étage 1) — les catégories contextuelles vivent dans l'étage 2, séparées.
- **PAS de vraies données** dans le dataset — synthétique uniquement.
- Ne « répare » pas la latence par message côté sidecar (c'est un choix produit Companion).

---

## Versioning + deploy

Le sidecar n'a pas de version sémantique propre (c'est un service, pas un package). Pas de bump. 

**Checks pré-commit (local, obligatoires avant de committer) :**
```bash
cd ~/Claude/code/Companion/infra/guard-service
python -c "import ast; ast.parse(open('server.py').read()); ast.parse(open('contextual.py').read()); ast.parse(open('build_dataset.py').read()); ast.parse(open('optimize.py').read())"
# lance le service en local et passe les 3 curls du § Objectif/Vérif
```

**Commit** (sur `feat/confidential-guard`, Conventional + HEREDOC + footer) :
```bash
git add infra/guard-service/
git commit -m "$(cat <<'EOF'
feat(guard): V2 contextual detection stage — DSPy + dsparkqwen

Stage 2 of the guard sidecar: when stage 1 (GLiNER PII) is clean and the
caller passes contextual=true, a DSPy-optimised Qwen3-8B (dsparkqwen) judges
whether the message carries contextual confidential info (business secrets,
health narrative, HR, legal, strategy) that NER misses. Fail-open, LLM
endpoint config-driven (GUARD_LLM_BASE, empty=off), no Companion change.

Difficulty: 8, delivered

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
git push
```

**Deploy sur `.44` — SUR GO EXPLICITE DE SOPHIE UNIQUEMENT (tour précédent).** Ne déploie pas de toi-même. Quand le GO est donné :
```bash
# 1. installer DSPy dans le venv déployé
ssh admin@192.168.86.44 'export PATH=$HOME/.local/bin:$PATH; cd ~/guard-service && uv pip install --python .venv/bin/python dspy openai'
# 2. copier les fichiers
scp infra/guard-service/{server.py,contextual.py,build_dataset.py,optimize.py} admin@192.168.86.44:~/guard-service/
scp infra/guard-service/data/{contextual_seed.jsonl,compiled_contextual.json} admin@192.168.86.44:~/guard-service/data/
scp infra/guard-service/com.odyssai.guard.plist admin@192.168.86.44:~/Library/LaunchAgents/
# 3. relancer launchd
ssh admin@192.168.86.44 'launchctl unload ~/Library/LaunchAgents/com.odyssai.guard.plist; launchctl load ~/Library/LaunchAgents/com.odyssai.guard.plist'
```
   - **Piège deploy** : le dataset se génère + s'optimise EN LOCAL (ou sur `.44` en one-shot), pas au boot du service. Le service ne charge que `compiled_contextual.json`. Ne mets pas la génération/optim dans le chemin de démarrage.
   - **Piège venv PATH** : `uv` est à `~/.local/bin` sur `.44` (pas dans le PATH SSH non-interactif) → `export PATH=$HOME/.local/bin:$PATH` d'abord (déjà dans la commande).

---

## Test de validation (après deploy, sur GO)

```bash
# service up + étage 2 prêt
curl -s http://192.168.86.44:8084/health
# attendu : {"status":"ok",...,"contextual_ready":true}

# secret d'affaires contextuel (GLiNER seul le raterait) :
curl -s -X POST http://192.168.86.44:8084/guard -H 'Content-Type: application/json' \
  -d '{"text":"On perd le client Airbus, il signe chez Thales pour 2,4M la semaine prochaine.","contextual":true}' | python3 -m json.tool
# attendu : sensitive=true, finding category=business_secret severity=high

# négatif dur (parle business sans être confidentiel) :
curl -s -X POST http://192.168.86.44:8084/guard -H 'Content-Type: application/json' \
  -d '{"text":"Explique-moi comment une entreprise signe un contrat commercial.","contextual":true}' | python3 -m json.tool
# attendu : sensitive=false

# compat V0 (sans le flag) — comportement inchangé :
curl -s -X POST http://192.168.86.44:8084/guard -H 'Content-Type: application/json' \
  -d '{"text":"mon IBAN FR76 3000 6000 0112 3456"}' | python3 -m json.tool
# attendu : sensitive=true (étage 1 GLiNER, identique à V0)

# NÉGATIF fail-open — coupe l'accès LLM et vérifie que /guard répond quand même :
#   (temporairement mettre GUARD_LLM_BASE vers un port mort dans le plist, relancer)
# attendu : contextual=true → HTTP 200, sensitive=false, PAS de 5xx, service vivant
```

Reporte à Sophie : le F1 sur le jeu de test (Objectif #2), la latence étage 2 mesurée, le taux d'échec de parse DSPy. Ces trois chiffres décident si la V2 est gardée telle quelle, élargie (plus de dataset), ou escaladée en V3 (LoRA).
