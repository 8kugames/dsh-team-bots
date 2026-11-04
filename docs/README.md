# DSH Team Bots

[中文](README.zh.md)

DSH Team Bots is a DSH (DeepSeek Harness) plugin — the npm package `dsh-team-bots` — that packs a collaborating crew of bots into one workspace: project group chats, a task board, write-scope parallel scheduling, memory and skills, usage and cost, plus a personal WeChat channel.

![DSH Team Bots workspace](assets/tasks.png)

This file is the English edition of the project documentation. The Chinese edition is [README.zh.md](README.zh.md); the repository root `README.md` keeps only a pointer to this page.

## Contents

- [1. Project Overview](#1-project-overview)
- [2. Quick Start](#2-quick-start)
- [3. Feature Overview](#3-feature-overview)
- [4. Architecture and Layout](#4-architecture-and-layout)
- [5. Testing and Development Conventions](#5-testing-and-development-conventions)
- [6. Troubleshooting and FAQ](#6-troubleshooting-and-faq)
- [Screenshots](#screenshots)

---

## 1. Project Overview

`dsh-team-bots` is a DSH (DeepSeek Harness) plugin that runs inside the DSH Web process, without a separate service. What it does is: let several bots divide the work across the same set of project spaces, and expose the collaboration process as a web workspace you can actually operate.

Three positioning points:

1. **Collaboration happens in projects, not in a chat window.** Every project has its own group chat, members, tasks and working directory; the project director bot splits the work, assigns it and accepts results in that chat.
2. **Parallelism is declared, not hoped for.** A task can declare which paths it intends to write, and the scheduler uses those declarations to decide whether two write runs in the same project may run at once: both sides must declare, and their path prefixes must not overlap. If either side does not declare, the runs are treated as serial.
3. **Everything is traceable.** Every run has a trajectory, duration, token count and cost; bot configuration keeps an immutable history that can be rolled back; secrets are stored encrypted, materialised as one-time plaintext files only when used, and burned right after.

The shape of the repository: `index.js` is the plugin entry point, `src/` is the server side and the scheduler, `ui/` is the workspace frontend, `tests/` are the guard tests, `docs/` holds design specs, review records and screenshots.

---

## 2. Quick Start

---

### 2.1 Requirements

| Item | Requirement |
| --- | --- |
| Node.js | ≥ 22.19 (see `engines` in `package.json`) |
| DSH CLI | installed; `dsh --version` self-checks |
| Plugin form | runs inside the DSH Web process, no standalone process and no standalone port |

---

### 2.2 Install into a DSH profile

```sh
cd <repo>
npm pack                                        # produces dsh-team-bots-<version>.tgz
dsh plugin --profile <name> add ./dsh-team-bots-<version>.tgz
dsh --profile <name>                             # read the tokenised dsh web entry from the startup log
```

---

### 2.3 One-shot reinstall (a profile is a snapshot)

```sh
npm run profile:install -- --profile <name>     # installs into team-bots when --profile is omitted
```

This command packs the current repository with `npm pack` into the repository's `.dist/`, reinstalls it into the target profile with `dsh plugin add`, and rewrites that profile's patch file to trigger a recomposition — the effect is a DSH restart without stopping the process.

**This is the easiest thing to get wrong: the plugin files inside a profile are a snapshot, and DSH does not pick up replaced files on its own.** After changing code you must reinstall (`npm run profile:install`), otherwise the running instance still executes the old code and the page sticks at "connecting to the team space".

Team data is decoupled from the profile: the data directory is decided only by `DSH_TEAM_WORKSPACE` / `DSH_TEAM_DATA`, so installing into another profile — or keeping several installs side by side — reads and writes the same data.

---

### 2.4 Local preview

```sh
npm run dev        # http://127.0.0.1:4317, fake runtime, data under .dev/ in the repository
```

The preview server uses a fake DSH runtime. It has **no authentication, touches no DSH configuration, and must not be used in production**. The port can be overridden with `PORT`.

---

### 2.5 Where data, secrets and skills live

| Content | Location |
| --- | --- |
| Team workspace root | `DSH_TEAM_WORKSPACE`, default `~/.dsh/workspace/team-bots` |
| Team data directory | `DSH_TEAM_DATA`, default `<workspace>/.data` |
| Main database | `<data dir>/team.sqlite` |
| WeChat channel database | `<data dir>/wechat-channel.sqlite` |
| Secret master key file | `<data dir>/secret.key` (back it up together, without it the existing ciphertext cannot be decrypted) |
| Long-term memory / message attachments | `<data dir>/memory/`, `<data dir>/messages/` |
| One-time secret runtime files | `<data dir>/secrets-runtime/`, burned when the TTL expires |
| Shared skill pool | fixed at `~/.agents/skills`, shared with the other agent tools on the machine |
| Project-local skills | `<project>/.agents/skills`, `<project>/.claude/skills`, `<project>/.codex/skills` |

A template for the common variables lives in `.env.example` at the repository root. Export it with direnv or an editor dotenv plugin — **do not put a `.env` file in the repository root**, because that would leak `DSH_*` into `npm test` and `npm run dev`.

---

### 2.6 Entry points and auto-login

```text
http://<host>:<port>/                     auto-login, straight into the team workspace
http://<host>:<port>/api/dsh-team/ui      the DSH Team Bots workspace (direct)
http://<host>:<port>/index.html           the native DSH web UI
```

The first visit to the home page exchanges the current startup token for a 30-day login cookie and redirects to the workspace, with no manual step. Auto-login means **anyone who can reach the port becomes owner**, so the service should only listen on the local machine or a trusted network; exposing it publicly requires an HTTPS reverse proxy that forwards Host and WebSocket correctly.

---

### 2.7 Common environment variables

Defaults come from `src/config.js` (resolution order: explicit env > value saved on the page > code default). A value saved on the page can be overridden by an env variable of the same name.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DSH_TEAM_WORKSPACE` | `~/.dsh/workspace/team-bots` | team workspace root |
| `DSH_TEAM_DATA` | `<workspace>/.data` | team database and run records |
| `DSH_TEAM_MAX_RUNS` | `6` | global concurrent run limit (1–16) |
| `DSH_TEAM_RUN_TIMEOUT_MS` | `3600000` | hard timeout for a single run (30 s – 6 h) |
| `DSH_TEAM_MAX_RUN_TOKENS` | `0` | per-run token cap, 0 disables it |
| `DSH_TEAM_STALL_TIMEOUT_MS` | `1200000` | how long without a new event counts as stalled, 0 disables it |
| `DSH_TEAM_SESSION_ROLLOVER_TURNS` | `256` | accumulated turns of one bound session before rollover, 0 disables it |
| `DSH_TEAM_CHAT_MAX_CHARS` | `800` | group-chat reply compression cap (full deliveries always go to task comments) |
| `DSH_TEAM_APPROVAL_TIMEOUT_MS` | `180000` | privilege-escalation approval window, auto-rejected on expiry |
| `DSH_TEAM_QUESTION_TIMEOUT_MS` | `180000` | question hand-off window |
| `DSH_TEAM_SECRETS_TTL_MS` | `1800000` | lifetime of one-time secret runtime files |
| `DSH_TEAM_DM_ARCHIVE_DAYS` / `DSH_TEAM_DM_KEEP_RECENT` | `7` / `100` | direct-message archive filter: days and count, intersected |
| `DSH_TEAM_UI_LANGUAGE` | `auto` | interface language: `auto` follows the DSH host, `zh` / `en` override it |
| `DSH_TEAM_SECRET_KEY` | — | secret master key (64 hex characters) |
| `DSH_TEAM_MODEL_PRICES` | — | model price JSON array (per million tokens), overriding the built-in defaults |
| `DSH_TEAM_AGENT_TEAM` | `0` | enable the native Agent Teams layer |
| `DSH_TEAM_MAX_TEAMMATES` | `3` | teammates per crew (1–8) |
| `DSH_TEAM_WECHAT` | `0` | personal WeChat channel (active after QR authorisation) |
| `DSH_TEAM_VISION_PROXY_PROVIDER` / `DSH_TEAM_VISION_PROXY_MODEL` | — | vision proxy model: a read-only transcription model derived when the main model has no vision ability |
| `DSH_TEAM_AUTO_REVIEW_DELEGATE` | `true` | spawn a sub-agent verification run when a delivery enters pending review |
| `DSH_TEAM_CODE_HYGIENE_EXTS` | built-in whitelist | extension overrides for the code-hygiene scan |
| `DSH_TEAM_USAGE_SNAPSHOT_CACHE_MS` | `30000` | usage snapshot TTL cache |
| `DSH_TEAM_CATALOG_STALE_MS` | `300000` | stale-while-revalidate window for the model catalogue |

---

## 3. Feature Overview

**Project group chat:** every project has one group chat and one project director bot. It supports plain messages, `@Bot`, `/task @Bot <title>`, `/remember` and `/clear`; typing `/` or `@` pops up completions for commands, skills and members. The group chat carries conclusions only; full deliveries go to task comments.

**Task board:** a Linear-style panel grouped by status, with a parent/child task tree, priority and assignee, comments delivered straight into a running session, and drag-to-transition; task details inline the delivery artefacts and the run list.

**Write-scope parallel scheduling:** once a task declares the paths it will write, two write runs in the same project are judged by those declarations — non-overlapping scopes may run in parallel, while overlapping scopes, or one side that does not declare, run serially. Write runs are independent of each other, and neither tasks nor group chats block one another.

**Memory and the skill pool:** bot-level and project-level long-term memory; after a task delivery a memory-review run is spawned (`memory_review` controls it, group-chat replies are additionally controlled by `chat_memory_review`), and the reusable facts it extracts enter a review queue for a human to confirm. The shared skill pool is fixed at `~/.agents/skills`, and a project can bring its own skill directories; skill changes go through proposal approval and keep a rollback snapshot.

**Versioned evolution and team tools:** changes to roles, models, intensity and skills go through proposal approval, and bot configuration keeps an immutable history that can be rolled back. The plugin registers seven team tools: `team_assign_task`, `team_review_task`, `team_remember`, `team_recall`, `team_propose_evolution`, `team_message_bot`, `team_request_secret`; bots can message each other directly.

**Secret pipeline:** secrets are encrypted with AES-256-GCM and stored; once approved they are materialised into the data directory (**not into the project workspace**), and burned when the run ends or the TTL expires; messages and run output are always masked as `$<name>`.

**Usage and cost:** tokens, call counts, cost and runtime are aggregated at three levels — global, project and bot; cost is computed from configurable model prices, and calls without a price are not billed as zero. Detail exports are available as CSV, together with monthly reconciliation.

**Approvals and questions:** when a bot asks for extra privileges or needs a human answer, it becomes a card in the workspace; approvals have a waiting window and time out to `rejected`, while an expired question keeps its card so it can still be answered later.

**Terminal:** each project has an interactive terminal whose commands have a hard timeout, with live tailing and cancellation; the history is persisted.

**Personal WeChat channel:** after QR authorisation, task activity is pushed to WeChat, and a plain-text command surface is available (see 4.4).

**Code hygiene:** a project can set a per-file line limit (800 lines by default); every run scans the workspace source files on the way out, and an over-limit file triggers one 【系统指令】 message to the project chat, asking the director to schedule a split card.

---

## 4. Architecture and Layout

---

### 4.1 Wiring

`apply(ctx, config)` in `index.js` is the only entry point, and its order is the dependency order:

```
resolveConfig(config)      → src/config.js      parse env / injected config into a defaulted config
openDatabase(dbPath)       → src/db.js          open and migrate SQLite
new TeamService(...)       → src/service.js     domain facade (methods mounted from src/services/*)
new DshRuntime(...)        → src/runtime.js     host runtime adapter (prompts, sessions, model recovery)
installTeamTools(...)      → src/tools.js       register the seven team tools
installSkillProvider(...)  → src/skills.js      wire the skill pool
installHttp(...)           → src/http.js        HTTP routes and UI static slices
```

Service initialisation is asynchronous: `service.initialize()` creates the database and seeds the default bots and buddies first, and only then does `service.start()` bring up the scheduler.

---

### 4.2 The `src/` directory

| Path | Responsibility |
| --- | --- |
| `index.js` | plugin entry point and wiring |
| `src/config.js` | configuration resolution: env / value saved on the page / code default, three levels |
| `src/db.js`, `src/db-migrations.js` | SQLite access and idempotent migrations (a new column can be added repeatedly) |
| `src/service.js` | the `TeamService` facade; domain methods are mounted onto the prototype via `defineMethods` in `src/services/*` |
| `src/services/` | domain method bodies: bots, projects, chat, tasks, runs, scheduler, memory, secrets, proposals, terminal, usage, system, wechat, approvals, questions, hygiene, model-fallback, write-scopes, file-policy, and more |
| `src/runtime.js`, `src/services/runtime/` | host adapter: prompt assembly, session lifecycle, model recovery, trajectories |
| `src/http.js` | HTTP routes, UI static slices, the `UI_STYLE_PARTS` style concatenation table |
| `src/api.js` | the `POST /api/dsh-team/api` single entry point for action dispatch |
| `src/tools.js` | team tool registration |
| `src/botmsg.js` | bot-to-bot direct messages via `team_message_bot`: idempotent persistence and delivery prompt assembly |
| `src/skill-parse.js` | skill package (`SKILL.md`) parsing: frontmatter first, falling back to the directory name and the first paragraph |
| `src/wechat/` | WeChat channel: `channel.js` (connection and push), `commands.js` (command surface), `store.js` (outbox and state) |
| `src/secrets.js`, `src/services/secrets.js` | secret encryption, materialisation and masking |
| `src/pricing.js`, `src/usage.js`, `src/usage-reconcile.js` | price table, usage aggregation and reconciliation |
| `src/skills.js`, `src/project-skills.js` | skill pool and project skill scanning |
| `src/seed-bots.js`, `src/updater.js`, `src/paths.js`, `src/util.js`, `src/errors.js` | seed bots, update check, path boundaries, general utilities, error types |

---

### 4.3 The `ui/` directory

The frontend is plain ES modules with no build step; every slice is loaded straight from an HTTP route.

| Path | Notes |
| --- | --- |
| `ui/index.html` | page shell: style links, vendor scripts, module entry |
| `ui/app.js` | application entry and render skeleton, 784 lines (bound by the 800-line rule) |
| `ui/modules/` | **20 module domains**: `state`, `api`, `util`, `icons`, `markdown`, `i18n`, `typing-linger`, `cards`, `usage`, `settings`, `composer`, `tasks`, `modal-layer`, `modal-forms`, `chat`, `solo-archive`, `events-board`, `events-click`, `events-submit`, `events-misc`. Each slice is loaded on its own via the `/api/dsh-team/modules/<file>` route, and cross-slice references always go through explicit `import` |
| `ui/styles/` | **21 style domains**: `base`, `boot`, `frame`, `main`, `buttons`, `surfaces`, `avatars`, `chat`, `chat-cards`, `chat-composer`, `chat-images`, `tasks`, `cards`, `usage`, `settings`, `global-config`, `modal`, `toast`, `a11y`, `wide`, `terminal` |
| `ui/i18n/zh.js`, `ui/i18n/en.js` | interface dictionaries |

Two hard conventions:

1. **Style slices must be registered.** The concatenation order is decided by `UI_STYLE_PARTS` in `src/http.js`, so a new style file must be registered in that table as well; the registration order is the cascade order, and the completeness of the table is guarded by `tests/styles-split.test.js`.
2. **The 800-line rule.** Both `ui/styles/*.css` and `ui/app.js` must stay under 800 lines per file; beyond that, split by responsibility into new domain files.

---

### 4.4 The WeChat channel

The channel is off by default (`DSH_TEAM_WECHAT=0`) and becomes active after QR authorisation. Its command surface is plain text, and `帮助 / help / ?` pulls it up at any time:

| Command | Effect |
| --- | --- |
| `帮助` / `help` / `?` | show the command help |
| `状态` | overview of the projects and the tasks pending review |
| `验收 <task number> [comment]` | accept a delivery, e.g. `验收 web-3 做得好` |
| `驳回 <task number> <reason>` | send it back for rework; the reason is mandatory |
| `详情 <task number>` | show the task card and its latest comments |
| `q` | list the project keys that can be assigned |
| `<key>: <message>` | forward a message into the project chat for the director to arrange, e.g. `web: 上线新版官网` |

Pushes go through a local outbox, and three semantic boundaries directly explain "WeChat missed the push / it was not resent":

- Items piled up before the channel connection was established (a process restart, or a re-login under a new account) are discarded and never resent; a transient reconnect inside one connection epoch is not a new connection and does not void what is already queued.
- A queued item is attempted at most three times (`OUTBOX_MAX_ATTEMPTS`); once the limit is reached it is discarded for good and never resent, and a non-retryable error is discarded immediately.
- Several pushes in the same round are merged into one send (a 1.5 s batching window, echoing at most the 5 oldest originals); **exactly one item is not merged**.

When investigating, look at `outbox.attempts` (the retry counter, persisted, not reset by a process restart) and `gave_up_at` (the discard timestamp): a value in either means the item was dropped by design, not by a bug.

---

### 4.5 Data and migrations

The main database is SQLite, and every schema change goes through the idempotent migrations in `src/db-migrations.js` (`PRAGMA table_info` checks the column first, then adds it), so old databases upgrade in place without a manual rebuild. When you back up the data, take `secret.key` along.

---

## 5. Testing and Development Conventions

---

### 5.1 Common commands

```sh
npm test                        # node --test "tests/*.test.js"
npm run dev                     # local preview (fake runtime)
npm run doctor                  # check the Node/DSH versions and the writability of the workspace and skill-pool paths
npm run profile:install         # pack and reinstall into a profile (team-bots by default)
npm run verify:agent-team       # verify the Agent Teams layer wiring
npm run backup                  # back up the team data
npm run restore-check           # check that a backup can be restored
npm run load-test               # load test
npm run fault-test              # fault injection
```

---

### 5.2 Guard tests

`tests/` holds 154 `*.test.js` files. Besides the functional cases, several architectural conventions are pinned down:

- `tests/styles-split.test.js`: `UI_STYLE_PARTS` corresponds one-to-one with the `ui/styles/` directory (no orphans, no missing entries, no duplicates), each file stays under 800 lines, production and preview share the same style summary, and the concatenation has zero drift.
- `tests/code-hygiene.test.js`: the semantics of the code-hygiene line limit (800 by default, the judgement line at limit × 110 %, a limit of 0 disabling it, one alert per violation, and a fresh alert after the file falls back under the limit).
- Cross-slice `import` guards and token-format guards cover the whole `ui/` source tree: a missing import after a slice split leaves the page on the boot screen, so this class of failure has to be caught by the guards in advance.

---

### 5.3 Commit conventions

- Every commit has the pre-commit hook bump the patch digit of `package.json` by one (`DSH_SKIP_VERSION_BUMP=1` skips it, for rollbacks or manual releases). **Take the committed version from `git show HEAD -- package.json`**, not from the file in the working tree.
- Commit messages use Conventional Commits style and carry the card number, e.g. `feat(ui): 全局配置页美术重设计（DSHBOTS-184）`.
- Commit with an exact pathspec (`git commit -- <pathspec>`): only the files inside your own write scope, so in-flight work from other sessions never gets swept in.
- The working tree often carries dirty files from other sessions; check `git status --short` before and after committing.

---

### 5.4 CI

Pushing a `v*` tag triggers the publish workflow (`.github/workflows/publish.yml`): it installs the dependencies, runs the full `npm test`, and only publishes to registry.npmjs.org when everything is green.

---

## 6. Troubleshooting and FAQ

**Q: I changed the code but the page is still the old one?**
The plugin files inside a profile are a snapshot and are not hot-reloaded. Reinstall with `npm run profile:install -- --profile <name>`. A page stuck at "connecting to the team space" usually has the same cause (the module slice routes are not installed).

**Q: Where does the data live, and how do I take it to another machine?**
Under the `<DSH_TEAM_DATA>` directory are `team.sqlite`, `wechat-channel.sqlite`, `secret.key`, `memory/` and `messages/`. Back it up with `npm run backup`, and **do not leave `secret.key` behind** — without it the existing ciphertext can never be decrypted again.

**Q: WeChat did not receive the push?**
Look at `outbox.attempts` and `gave_up_at` first: a value means the item was dropped by design (piled up before the connection was established, three attempts exceeded, or a non-retryable error), not that it was missed; no value means it is still in the queue.

**Q: What is the "code hygiene" alert in the project chat?**
At the end of every run the source files in the project workspace are scanned, and a file over the project's agreed line limit (800 by default, judgement line 880) triggers one 【系统指令】 asking the director to schedule a split card. Raise the limit in the project settings, or set it to 0 to switch the check off.

**Q: What does "planned migration · target page" on the global configuration page mean?**
The functional migration of that module has not landed yet — this is only a visual annotation, so do not read it as "already migrated". Once the migration is done, the module and that annotation will be removed from this page.

**Q: There is still Chinese after switching to English — is that a bug?**
A known gap. The interface language dropdown itself works, but the card titles, descriptions and other main copy of the settings page and the global configuration page are still largely hard-coded Chinese; full i18n coverage is not in place yet.

**Q: Can it be exposed to the public internet?**
The plugin ships no sandbox: bot sessions run under DSH's `danger-full-access` as the current user and can read and write everything that user can reach; `<workspace>/{project}` is logical isolation, not a strong sandbox. Together with the auto-login on the home page (reaching the port means owner), public exposure requires an HTTPS reverse proxy and your own authentication, and teams that do not trust each other should not share one DSH instance and workspace.

---

## Screenshots

The task board groups the work by status, with the project chats and the bot roster on the left:

![Task board](assets/tasks.png)

Usage stats carry the summary window, the last 14 days of detail, a per-model / per-bot / per-project breakdown and a CSV export:

![Usage stats](assets/usage.png)

The same page in the dark theme:

![Dark usage stats](assets/usage-dark.png)

The global configuration page gathers the team-level cards, the run budget, the DSH paths, the secrets and the model prices:

![Global configuration](assets/global-config-light.png)

The same page in the dark theme:

![Dark global configuration](assets/global-config-dark.png)

---

## License

Apache-2.0, see `LICENSE` and `NOTICE` in the repository root.
