---
title: Microsoft-Decision-1 changed 8% of its answers under the same snapshot ID
date: 2026-10-29
summary: Between Oct 20 and Oct 27, 8.3% of Microsoft-Decision-1's top answers changed, with the same pinned snapshot and the same provider. Score questions moved most. Accuracy didn't.
draft: false
---

We send the same 1,472 questions to every decision model on OpenRouter each day. On Oct 20 and again on Oct 27, Microsoft-Decision-1 was served as `microsoft-decision-1-20261009`, by Azure both times. Between the two runs, **8.3% of top answers changed** (122 of 1,472; 95% CI 7.0–9.8%).

That isn't noise. Sent the same request twice a few minutes apart, the model changes 1.2% of answers (pooled over three days of repeats). And it shifted once: from Oct 27 to Oct 28, only 0.8% changed.

| Question type | Changed, Oct 20 to Oct 27 |
|---|---|
| Score (rate on a scale) | 19.0% (83 of 437) |
| Yes/no | 5.0% (36 of 726) |
| Pick one | 1.0% (3 of 309) |

Accuracy on our gold-labeled questions didn't move: 91.5% on both days. The answers are different, not better or worse.

We can't tell why. A snapshot ID says which weights you asked for, not how they're served; hardware, batching, quantization or runtime changes can all move probabilities without a new version. It may not be Azure either. OpenRouter's decisions API is in alpha, and a change in how it passes requests to one provider would look the same from here; most models didn't move in the same window. If you set thresholds on this model before Oct 27, they now apply to different numbers, mostly on Score questions.

It isn't the only one. Perplexity Decider Flash v1.2 and Decider v1.2 shifted once in the same window, by 2.2% and 1.1%, under unchanged snapshot IDs. Neither has changed a single answer on repeat.

Daily runs started Oct 27, so this change can only be placed between Oct 20 and Oct 27. From here, the [change log](/changes/#log) dates shifts to the day.

[Model page](/models/microsoft--microsoft-decision-1/) · [Raw responses](https://github.com/bomliu/decision-drift/tree/main/results) · [Method](/method/)
