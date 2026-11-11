# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

decision-drift is an open daily tracker of **decision models** on OpenRouter (models that return typed answers with probabilities, called through OpenRouter's `api/alpha/decisions` endpoint). The same frozen probe suite goes to every model each day. Reports cover drift vs. day 1, noise floor, silent snapshot swaps, robustness (option shuffle, paraphrase), accuracy/calibration on gold labels, and latency/errors/cost. The site is published at decisiondrift.dev. See `README.md` for the method notes.

## Two repos: `private/` is separate

- `private/` is a **separate private git repo** (`bomliu/decision-drift-private`) nested inside this one and git-ignored by the public repo. Commit and push to it separately with `git -C private ...`.
- It holds the private split (`private/core-v1.private.jsonl`), candidates, LLM labels (`private/labels/`), drafts, the noise subset, private results (`private/results/<date>/<run>/`), notes and unpublished post drafts.
- **Never copy private items, labels, private results, drafts or notes into the public repo.** The only things published about the private split are its SHA-256 hash (in `suite/manifest-v1.json`) and aggregate scores (in `reports/`). It exists so vendors can't train on the whole suite.
- **Don't use git worktrees** for sessions here. A worktree contains only the public repo, so `private/` would be missing, and the runner, report, spot-check and label-correction scripts all read from it.

## Environment

- Zero-dependency TypeScript, run directly by Node ≥ 23 (type stripping). Local Node is v26.10.0, and the Docker images use `node:26.10-slim`. There is no `package.json`, build step, linter or test suite at the root. (`.railway/package.json` only pins the Railway CLI for the IaC file.)
- `.env` holds only `OPENROUTER_API_KEY`. `loadEnv()` in `src/lib.ts` parses the file, but only `OPENROUTER_API_KEY` is used from it (the process environment wins if set). **Never read or print `.env`.**
- `BUDGET_STOP` (default `5`, dollars of key spend in the current UTC day), `PORT`, `SITE_DIR`, `UMAMI_SRC`, `UMAMI_WEBSITE_ID` come from the process environment only.
- Commits are authored as `bomliu <1945172+bomliu@users.noreply.github.com>` (the global git identity; matches history, including the collector's commits).

## Commands

Every script is `node src/<name>.ts` with `--flag value` arguments; usage is in each file's header comment.

```bash
# Full daily collection (core run with shuffle+para variants, noise duplicates, report vs. day-1 baseline)
scripts/daily.sh [run-name]          # env: RUN_DATE=YYYY-MM-DD, RUN_MODELS=a,b to limit models

# Pieces of it
node src/run.ts --items suite/core-v1.public.jsonl,private/core-v1.private.jsonl --run daily --variants shuffle,para [--models id1,id2] [--limit N] [--date YYYY-MM-DD]
node src/run.ts --items private/noise-subset-v1.jsonl --run daily-dup
node src/report.ts --date YYYY-MM-DD --run daily --dup daily-dup --compare-date 2026-10-20 --compare-run day1

# Site
node src/site.ts [--out site-dist] [--drafts true]   # builds static HTML into site-dist/
node src/serve.ts                                     # serves SITE_DIR (default site-dist) on PORT (default 8080)
```

`run.ts` and `label.ts` spend real OpenRouter money. For a cheap check, limit with `--models <one id>` and `--limit N`, and use a throwaway `--run` name so it doesn't mix with `daily` results (and delete those result dirs afterwards). `run.ts` refuses to start if it can't read the key's daily spend, and stops when it reaches `BUDGET_STOP`.

## Architecture

**Data flow:** suite → `run.ts` → raw results → `report.ts` → `reports/<date>-<run>.{md,json}` → `site.ts` → static site.

- `src/lib.ts`: shared core. `Item`/`Question` types (question types `noul` | `choice` | `score`), OpenRouter calls (`decide` with retries/backoff, `chat` for labelers, `fetchCatalog`, `keyUsage`), `BUDGET_STOP`, `canonical` (sorted-key JSON) + `sha256` for request/suite hashes, the deterministic `rng`/`shuffled` (seeded by item/question id, so variants are identical every day), `pool` for concurrency, `readJsonl` (reads `.jsonl` or `.jsonl.gz` transparently), and `redact` (strips OpenRouter `user_id`s from error bodies before anything is saved).
- `src/run.ts`: builds jobs per item (`base`, plus `shuffle` = choice criteria reordered, `para` = paraphrased instructions from the item's `paraphrases`). Models = OpenRouter catalog minus `suite/models-excluded.json`. `suite/provider-pins.json` pins listed models to their maker without fallback from `since`. Each record gets a `req_hash`. Records go to `results/<date>/<run>/<model>.jsonl` for public items and `private/results/...` for items with `split: 'private'`.
- `src/answers.ts`: normalizes raw answers into a common `Norm` (top answer + distribution) plus metric helpers (`tv`, `wilson`, `quantile`, `goldMatches`, `loadRun`). Used by `report.ts` and `select.ts`.
- `src/report.ts`: per-model metrics for one run. It reads both splits, uses a 30-day window of earlier runs, and pools noise over the last 7 runs that had a `-dup` run.
- `src/site.ts`: builds the whole site from the committed `reports/*.json` (the `2026-10-20` `day1` baseline plus later `daily` runs), `suite/manifest-v1.json`, `status.json` and `posts/*.md`. `private/post-drafts/` is included only with `--drafts true`. `src/site-weights.js` is browser JS inlined into the home page.
- `src/status.ts` writes `status.json`. `src/compact.ts` slims and gzips finished result files in place.

**Suite construction (one-time / rare, all reading `private/`):** `build-candidates.ts` (drafts + datasets → `private/candidates.jsonl`) → `label.ts` (LLM labelers → `private/labels/`) → `select.ts` (gold = reference label agrees with both labelers; picks the core, splits ~70/30 public/private, freezes `suite/manifest-v1.json` with hashes) → `spot-check.ts` / `spot-check-notes.ts` (human review) → `apply-label-corrections.ts`.

**Suite rules** (from `suite/manifest-v1.json`): items are immutable and the public suite is append-only. A fix retires an item and adds a new one. Questions are never tuned against model results. Requests (state + questions) never change. Only reference labels can be corrected after human review, and those corrections are logged in the manifest.

## Deployment (Railway, `.railway/railway.ts`)

- **collector**: cron at 10:17 UTC runs `deploy/collector.Dockerfile` → `scripts/collect.sh`. It clones/pulls both repos on a persistent volume, runs `scripts/daily.sh` (skipping if today's results already exist), then `compact.ts` and `status.ts`. It commits `data: private results <date>` to the private repo and `data: daily run <date> (<status>)` to the public repo, and pushes both. Most commits in history are these.
- **site**: `deploy/site.Dockerfile` runs `site.ts` at build and `serve.ts` at runtime. It rebuilds on every push to `main`, data commits included.
- Expect the collector to push data commits to both repos daily: pull before committing.
