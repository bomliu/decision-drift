#!/bin/sh
# Daily collection: core run (variants weekly per model), noise-floor duplicates a few minutes later, then a report
# comparing against the day-1 baseline. Usage: scripts/daily.sh [run-name]   (default: daily)
set -e
cd "$(dirname "$0")/.."
RUN="${1:-daily}"
DATE="${RUN_DATE:-$(date -u +%Y-%m-%d)}"
MODELS="${RUN_MODELS:-all}"   # RUN_MODELS=a,b limits a test run to some models
# Base requests go to every model every day. The shuffle and paraphrase variants go to each model once a week
# (and again when its snapshot ID changes); report.ts carries the latest measurement forward on the other days.
node src/run.ts --items suite/core-v1.public.jsonl,private/core-v1.private.jsonl --run "$RUN" --date "$DATE" --models "$MODELS" --variants shuffle,para --variants-every 7 --parallel-models 12 --per-model 5
node src/run.ts --items private/noise-subset-v1.jsonl --run "$RUN-dup" --date "$DATE" --models "$MODELS" --parallel-models 12 --per-model 5
node src/report.ts --date "$DATE" --run "$RUN" --dup "$RUN-dup" --compare-date 2026-10-20 --compare-run day1
echo "Report: reports/$DATE-$RUN.md"
