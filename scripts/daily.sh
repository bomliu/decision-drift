#!/bin/sh
# Daily collection: core run with variants, noise-floor duplicates a few minutes later, then a report
# comparing against the day-1 baseline. Usage: scripts/daily.sh [run-name]   (default: daily)
set -e
cd "$(dirname "$0")/.."
RUN="${1:-daily}"
DATE="$(date -u +%Y-%m-%d)"
node src/run.ts --items suite/core-v1.public.jsonl,private/core-v1.private.jsonl --run "$RUN" --variants shuffle,para --parallel-models 12 --per-model 5
node src/run.ts --items private/noise-subset-v1.jsonl --run "$RUN-dup" --parallel-models 12 --per-model 5
node src/report.ts --date "$DATE" --run "$RUN" --dup "$RUN-dup" --compare-date 2026-10-20 --compare-run day1
echo "Report: reports/$DATE-$RUN.md"
