# decision-drift

An open, reproducible tracker for **decision models**: models such as TypeSafe Jev, Cloudflare Clef, Perplexity Decider and OpenAI Luna Decisions, which return typed answers with probabilities instead of text. Every hosted decision model on OpenRouter gets the same frozen probe suite every day. The tracker reports:

- **Drift:** whether answers changed relative to day 1, beyond each model's own noise floor
- **Noise floor:** how much answers change between identical requests sent minutes apart
- **Silent snapshot swaps:** whether an alias quietly started pointing at a new version
- **Robustness:** sensitivity to option order and to paraphrased instructions
- **Accuracy and calibration** on gold-labeled questions
- **Latency, error rate and cost**, as measured from the runner

## Layout
| Path | What |
|---|---|
| `suite/core-v1.public.jsonl` | Public split of the v1 core suite. Append-only; items are never edited. |
| `suite/manifest-v1.json` | Coverage, labeling method, and SHA-256 hashes of the public and private splits |
| `suite/noise-ids-v1.json` | States re-sent for the noise-floor measurement |
| `suite/models-excluded.json` | Models that can't answer the suite's question types, with the reason |
| `private/` | Private split and drafts (**git-ignored**) |
| `results/<date>/<run>/<model>.jsonl` | Raw responses for public items |
| `reports/` | Per-run reports |
| `src/` | Zero-dependency TypeScript (Node ≥ 23 runs it directly) |

## Running
```bash
# put OPENROUTER_API_KEY=... in .env (never committed)
node src/run.ts --items suite/core-v1.public.jsonl,private/core-v1.private.jsonl --run day1 --variants shuffle,para
node src/run.ts --items <noise subset> --run day1-dup
node src/report.ts --date YYYY-MM-DD --run day1 --dup day1-dup
```
The runner stops when the key's total spend reaches `BUDGET_STOP` (default $22).

## Method notes
- Questions follow the published System One conventions (instructions, criteria, an explicit `none` option). They are identical for every model and are **never tuned against results**.
- **Gold labels:** a question is gold only when the reference label agrees with both independent LLM labelers (GPT-6.1 Sol and Gemini 4 Argon). The reference label comes from the item's author, the source dataset, or the generator for synthetic logs.
- **The private split** (~30%) exists so vendors can't train on the whole suite. Only its hash and aggregate scores are published.

## Sources and licenses
- Banking77 test set: PolyAI, CC BY 4.0
- CLINC150 ("plus" test set): CC BY 3.0
- Authored items, synthetic logs, results and reports: CC BY 4.0
- Code: MIT (see `LICENSE`; data terms in `DATA-LICENSE.md`)
