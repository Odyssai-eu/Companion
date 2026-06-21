# Deploy Companion — runbook

Procédure complète, exécutable commande par commande, pour déployer Companion
(`thecompai/app`) en prod. Pensée pour qu'un agent (MiniMax, Claude, …) la suive
seul, sans rien deviner. Suis les étapes **dans l'ordre** ; chaque étape dit quoi
vérifier avant de passer à la suivante.

> Règle d'or (Sophie) : **ce qui tourne sur le serveur == ce qui est sur `main`**.
> Pas de hot-patch qui diverge de git. On commit, on push, on deploy — toujours.

---

## 0. Topologie (les faits fixes)

| Quoi | Valeur |
|---|---|
| Repo local | `/Users/sophie/Claude/code/thecompai/app` (le `.git` est dans `app/`, pas à la racine `thecompai/`) |
| Branche | `main` |
| Remote `internal` | `admin@192.168.86.39:/Users/admin/git-repos/companion.git` (bare repo sur le host — **la chaîne de deploy**) |
| Remote `origin` | `ssh://git@192.168.86.141:2222/thecompai/app.git` (**Forgejo / FJ** — le master + backup) |
| Host prod | `admin@192.168.86.39` |
| Checkout prod | `/Users/admin/companion` (remote `localmirror` = miroir local du bare `internal`) |
| Container app | `companion-app`, port **`:3100 -> 3000`** |
| Container db | `companion-db` (Postgres, persistant) |
| Health | `GET http://192.168.86.39:3100/api/health` → `{"status":"ok","version":"X","engines":N}` |

Le script qui orchestre tout : **`scripts/deploy-dev.sh`**. Les défauts du script
collent déjà à cet install (host `.39`, dir `/Users/admin/companion`, remote
`internal`/`localmirror`, service `app`, docker `/usr/local/bin/docker`) — **aucune
variable d'env à passer**.

---

## 1. Pré-flight (toujours, avant de toucher quoi que ce soit)

```bash
cd "/Users/sophie/Claude/code/thecompai/app"
git branch --show-current        # doit être: main
git status --short               # idéalement vide (voir étape 2 si du code traîne)
git log --oneline -5             # repère le dernier commit + le dernier "chore: bump to vX"
```

**Build local — obligatoire.** On valide tsc + vite + esbuild AVANT de toucher la
prod, sinon un build cassé fait perdre un cycle docker sur `.39`.

```bash
npm run build
# = tsc -b && vite build && esbuild server/index.ts --bundle --platform=node \
#   --format=esm --packages=external --outfile=dist/server/index.js
```

Si ça échoue → **stop**, corrige, ne déploie pas. (Le warning "chunks larger than
500 kB" est cosmétique, on l'ignore.) `dist/` est gitignored → pas de souci de
working tree sale après le build.

---

## 2. Si du nouveau code n'est PAS encore committé

`deploy-dev.sh` a un **pré-flight qui REFUSE de déployer** si le working tree
contient autre chose que `package.json` modifié (leçon 2026-05-20 : 5 deploys de
suite n'ont shippé que des bumps de version parce que le code feature était resté
non-committé). Donc commit ton code d'abord :

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(scope): description courte à l'impératif

Détail si utile (le pourquoi, pas le quoi).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

Conventions (non négociables) : **Conventional Commits** (`feat(...)`, `fix(...)`,
`chore(...)`, `docs(...)`) + **HEREDOC** pour le multi-ligne + footer
**`Co-Authored-By`**. Jamais `--no-verify`. Nouveaux commits, **jamais** `--amend`.

Si le working tree est déjà clean (code committé par toi ou un autre agent), saute
cette étape.

---

## 3. Choisir le niveau de version

`deploy-dev.sh [patch|minor|major|skip]` — `patch` est le défaut.

- **`patch`** (défaut) : bump `0.2.x → 0.2.(x+1)`, crée le commit `chore: bump to
  vX`, puis push + deploy. **C'est le cas standard** quand tu déploies du nouveau
  code/feature qui n'a pas encore son propre numéro.
- **`minor` / `major`** : pour un palier important / breaking.
- **`skip`** : pas de bump. À utiliser **seulement** si le contenu à déployer est
  déjà committé sous une version qui n'a **jamais** été déployée.

**La règle : un numéro de version == un contenu déployé.** Ne déploie jamais deux
contenus différents sous le même numéro (ça casse l'audit trail).

Pour décider proprement, compare ce que la prod tourne à ton HEAD local :

```bash
LOCAL=$(git rev-parse --short HEAD)
PROD=$(ssh admin@192.168.86.39 'cd /Users/admin/companion && git rev-parse --short HEAD')
echo "local=$LOCAL  prod=$PROD"
# Si PROD a déjà la version bumpée mais PAS ton nouveau code  → 'patch' (le code a besoin de son bump)
# Si ton code est committé sous une version jamais déployée   → 'skip'
```

---

## 4. Déployer

```bash
cd "/Users/sophie/Claude/code/thecompai/app"
./scripts/deploy-dev.sh patch        # ou: minor | major | skip
```

Ce que le script fait, dans l'ordre :
1. **pré-flight** : refuse si working tree sale (hors `package.json`) ;
2. **bump** : `node scripts/bump-version.js patch` → édite `package.json`, commit
   `chore: bump to vX` (sauté si `skip`) ;
3. **push** : `git push internal main` (vers le bare repo sur `.39`) ;
4. **deploy distant** (en une commande ssh) :
   `cd /Users/admin/companion && git pull localmirror main && /usr/local/bin/docker
   compose up -d --build app` — puis affiche `docker ps` des containers `companion`.

Il **ne rebuild que le service `app`** — JAMAIS `compose up` complet (le compose
déclare un service `nemo-memory` qui entre en collision sur `:8765` avec le nemo
host-process = le vrai LightRAG ; un `up` global échoue). Les migrations `.sql`
sont appliquées au boot par `server/db/migrate.ts`.

À la fin, le script imprime `→ deployed to http://192.168.86.39:3100`.

---

## 5. Pousser sur Forgejo (FJ) — le script ne le fait PAS

`deploy-dev.sh` ne pousse que sur `internal`. Le master/backup vit sur **FJ
(`origin`)** → pousse-le toi :

```bash
git push origin main
```

---

## 6. Vérifier (post-deploy)

```bash
# 1. health + bonne version
curl -s http://192.168.86.39:3100/api/health
#   attendu: {"status":"ok","version":"<la version que tu viens de bump>","engines":N}

# 2. tout est synchro sur le même commit
echo "local : $(git rev-parse --short HEAD)"
echo "origin: $(git rev-parse --short origin/main)"      # FJ
echo "internal: $(git rev-parse --short internal/main)"  # chaîne deploy
#   les trois doivent être IDENTIQUES

# 3. logs de boot — pas d'erreur
ssh admin@192.168.86.39 'export PATH=/usr/local/bin:$PATH; docker logs --tail 25 companion-app 2>&1' \
  | grep -iE "error|listen|ready|started|fail"

# 4. (si tu as ajouté une route) vérifie qu'elle est montée — 200/401, PAS 404
curl -s -o /dev/null -w "%{http_code}\n" http://192.168.86.39:3100/api/<ta-route>
```

Deploy réussi = health renvoie la bonne version + les 3 refs git identiques + pas
d'erreur dans les logs.

---

## 7. Rollback (si la prod est cassée)

```bash
# repère le commit sain précédent (ex. via git log)
PREV=<short-sha-sain>
ssh admin@192.168.86.39 "export PATH=/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:\$PATH; \
  cd /Users/admin/companion && git reset --hard $PREV && docker compose up -d --build app"
# puis aligne git localement : git revert <commit-cassé> OU reset, recommit, re-push internal + origin
```

---

## Gotchas (les pièges déjà vécus)

- **PATH ssh non-interactif** : `node` et `docker` ne sont pas sur le PATH d'un
  `ssh` non-interactif. Le script gère docker via
  `PATH=/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin`. Si tu
  lances une commande docker à la main sur `.39`, préfixe ce PATH.
- **`docker-credential-desktop`** : vit sous le bundle Docker.app, pas sur le PATH
  ssh nu ; un cold resolve d'image (1er build après reboot) peut mourir sur "error
  getting credentials" → d'où le PATH étendu ci-dessus.
- **`| tail` avale l'exit code** : le script met `set -o pipefail` sur le shell
  distant pour qu'un build raté soit bruyant (sinon il imprimait "deployed" alors
  que le container gardait l'ancienne image).
- **`nemo-memory` :8765** : ne JAMAIS faire `docker compose up` global — cible
  toujours le service `app` seul.
- **Pré-flight dirty** : si le script refuse avec "uncommitted changes", commit (ou
  `git stash`) ton code d'abord (étape 2). Il n'auto-commit QUE `package.json`.
