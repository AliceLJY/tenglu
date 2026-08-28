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
| Character-level accuracy | 90.6% | 93.7% | 99.5% |
| Speaker attribution | 95.1% | 95.1% | **100%** |
| Message order | 100% | 100% | 100% |

Speaker attribution samples the bubble background color (WeChat green vs. white) rather than guessing from position — it survived three platforms and three OCR engines without dropping once.

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
- **M2 (in progress, Level 3):** Level 1 cut the measured on-device displacement stage from 218.8 s to 158.2 s with byte-identical output. Level 3 now prepares one crop-local 1/4-scale grayscale frame for adjacent searches while stitch keeps full-resolution rematching; its on-device timing and accuracy are awaiting verification. No native modules unless pure JS provably cannot reach the target.
- Portrait phones only. Foldables: fold it first. iOS build planned (the algorithm is already verified on iOS Vision).

## Development

Built through AI collaboration: design & acceptance by Claude, implementation by Codex, cross-verified by an independent iOS implementation. Every milestone gated on reproducible benchmarks (`verify/run-node.js`) and accuracy scored against real ground truth (`verify/score.py`) — private test data never enters the repo.

```bash
cd verify && npm install
node run-node.js <frames-dir> 4 wechat
```

## License

MIT
