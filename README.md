# 誊录 Tenglu

**Turn a scrolling screen recording into a clean Markdown transcript. 100% on-device.**

Record yourself scrolling through a WeChat chat or a Xiaohongshu comment section. Tenglu stitches the frames into one long image, OCRs it, and hands you a faithful, ordered, copy-pasteable transcript — ready to feed to any AI you choose.

The name comes from 誊录, the Song-dynasty imperial examination practice of having clerks copy every candidate's paper verbatim so graders couldn't recognize handwriting. That is the whole product promise: **faithful transcription, zero interpretation.**

## Why

Apps summarize your content for you and keep the raw material. Tenglu does the opposite: it gives you the raw material and stays out of the way.

- **Restore, don't analyze.** Output is a plain transcript (speaker + text, in order). What model reads it is your business.
- **Nothing leaves the phone.** No server, no API key, no account. The APK ships with `android.permission.INTERNET` explicitly blocked — verified by running the full pipeline in airplane mode.
- **No content filtering.** Your screen, your data, your transcript.

## Measured accuracy

Validated against ground truth exported from the actual WeChat database (44 messages, real conversation):

| Metric | Android (ML Kit) | macOS (Vision) | iOS (Vision, independent impl.) |
|---|---|---|---|
| Character-level accuracy | 96.2% | 99.6% | 99.5% |
| Speaker attribution | 39/39 | 39/39 | 39/39 |
| Message order | 100% | 100% | 100% |

Denominator is 39: of the 44 recorded messages, 5 are pure sticker/emoji sends that no OCR
engine can read, so they are excluded. Earlier revisions of this table reported the three
columns under two different denominators (41 / 41 / 39), which made iOS look more accurate —
under one denominator all three are the same result.

Speaker attribution samples the bubble background color (WeChat green vs. white) rather than
guessing from position — it held at 39/39 across three platforms and two OCR engines.

### What was actually tested

Be clear about the scale — these two clips are the **entire** validation set:

| | WeChat one-on-one chat | Xiaohongshu note + comments |
|---|---|---|
| Recording length | **27.0 s** | **32.0 s** |
| Frames at 4 fps | 108 | 128 |
| Screen | 720 × 1652 | 720 × 1652 |
| Ground truth | 44 messages (15 mine / 29 theirs), 39 text-only totalling **569 characters** | none — no exported truth exists for this content |
| Longest / shortest message | 133 chars / 1 char | — |
| Total scroll distance | 3,744 px | 10,415 px |
| Stitched long image | 720 × 5,106 | 720 × 13,558 |
| Output | 40 messages | 202 lines / ~2,375 characters |

A WeChat **group chat** was added later as an ad-hoc test (44.2 s / 177 frames / 60 real messages
in range): 59 of 60 messages recovered, all 35 anchor checks passed, 10.2 s total.
No character-level figure for group chat — the screen shows per-group display names while the
database exports wxids, so no verbatim ground truth can be built.
Two grey-background bubbles (RGB 225) could not be resolved; the app flagged them and skipped
them rather than guessing.

So: **one 27-second WeChat conversation with a 569-character ground truth is the only
character-level accuracy measurement in this README.** The Xiaohongshu clip has no exported
ground truth, so it only verifies coverage (line count, scroll distance, anchor health) —
not per-character correctness.

**Only these two apps have ever been run.** WeChat one-on-one and Xiaohongshu. Not group chats,
not other messengers, not dark mode, not recordings longer than ~30 seconds. Generic mode should
work on any scrolling text, but "should" is not "was measured".

## How it works

```
video → sparse pre-scan → detect scroll region (hysteresis threshold, adaptive)
      → fixed-interval frames → per-frame displacement (DS=4 coarse SAD search)
      → keyframe selection (rebound frames excluded) → stitch (two-stage SAD + jump-cut guard)
      → segmented OCR → position-based dedupe → Markdown
```

Design rules learned the hard way (full engineering log in [PLAN.md](PLAN.md), Chinese):

- **Prefer duplication over loss.** Overlap can be deduped; lost content is gone. Displacement estimates are conservative and the output layer cleans up.
- **Don't parse structure.** Early versions tried to label "reply-to" and like-counts with regexes — 4 errors in 48 comments. Plain positional text: zero. The AI reading the transcript is better at structure than any regex.
- **Every self-check lied at least once.** The only reliable judge was comparing output against decrypted ground truth. If you can't diff against reality, you don't know your accuracy.

## Status

- **M1 (done):** minimal Android APK — pick video → transcript → clipboard, with per-stage timing. WeChat mode + generic mode.
- **M2 (done):** 247.0 s → 161.6 s on-device (−34.5%), accuracy unchanged throughout (byte-identical output at every level). Per-stage timing localised the real bottleneck: **JPEG decode in JS — 71% of the pipeline**, not the SAD search we all assumed.
- **M3 (verified on device):** a text-anchor architecture that skips pixel alignment entirely — OCR every frame, derive inter-frame offsets from shared text lines, dedupe geometrically, and sample a few pixels only for bubbles whose speaker coordinates alone cannot resolve. Same phone, same OCR engine, same ground truth as the stitching path: **6.4 s vs. 161.6 s (25× faster)** with character accuracy **91.4% vs. 90.6%** and speaker 39/39 on both. Generic mode passes all 42 anchor checks. Still gated behind a toggle — stitching remains the default until dark mode and longer recordings are covered.
- Portrait phones only. Foldables: fold it first. iOS build planned (the algorithm is already verified on iOS Vision).

## Development

Built through AI collaboration: design & acceptance by Claude, implementation by Codex, cross-verified by an independent iOS implementation. Every milestone gated on reproducible benchmarks (`verify/run-node.js`) and accuracy scored against real ground truth (`verify/score.py`) — private test data never enters the repo.

```bash
cd verify && npm install
node run-node.js <frames-dir> 4 wechat
```

## License

MIT
