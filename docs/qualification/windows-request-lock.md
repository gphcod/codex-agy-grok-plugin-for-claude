# Windows pre-provider request lock qualification

Owner date: 2026-11-02 Pacific. [Structured evidence](../measurements/request-lock-windows.json). Applies to Codex-hosted **1.1.2** and Claude-hosted **1.0.0-rc.8**.

## Reproduced failure and fix

The recorded failure occurred before a Claude-hosted provider started: EPERM while replacing `claims/requests/scope-…json` to add provider/job. The OS handle holder was not captured. The old atomic writer already retries five seconds. A real Windows FileStream/FileShare.Read fixture keeps this file unreplaceable beyond that window; the old writer fails, while the corrected request path completes and replays under the still-held handle with exactly one provider submission.

The root stays immutable. Complete private, flushed files are linked exclusively into generation-specific binding/prepared names. An owner hard link gates cleanup: only its successful unlinker may remove the shared root, and failed removal restores the marker. Terminal reads precede binding reads; prepared without a valid binding is blocked. Paired prepared/marker checks handle publication racing cleanup. No provider retry is introduced for a storage error.

## Regression and compatibility evidence

Eighteen publication regressions per host cover the native Windows lock, complete entry/replay, interrupted writes, immutable conflicts, corrupted stages, between-read progress, competing cleanup/replacement generations, marker restoration and preparation/cleanup races. Existing request suites also run. Final full-suite counts are recorded in the release qualification and handbook.

Actual previous/current companions were exercised with isolated null adapters. New readers replay completed legacy inline records with zero extra submissions. Older Claude rc.6 and Codex 1.1.1 readers fail closed on the new format with retained and pruned bodies: old Claude exit 2, old Codex exit 1; neither submits again. The current reader preserves its pruned-request tombstone and exits 1. Two intended provider submissions per host cover separate old/new requests. Unfinished legacy roots remain occupied for explicit reconciliation.

## Review, costs and limits

Claude identified the cross-stage read race and missing publication flushes; both are addressed, with the documented Windows durability limit. Its closing review accepted those resolutions and raised a conditional live-cleaner race; application cleanup requires a proven-gone owner or failed own preparation, and the helper additionally implements both paired checks with two deterministic regressions. Argon found no actionable issues in the compact helper review. Grok’s bounded source reviews ended at their deadline and are not approvals.

Both helper copies have SHA-256 bb64388a0bb9bdda457c504db8c0fd1a0cc1a69ca2fffe505b9f8325ed1065e8. Other cross-host core parity is not implied. The format retains four request-related names per completed request. These extra names, stage reads and flushes are maintenance/runtime costs, not token savings. Healthy framing, model defaults and per-turn permissions are unchanged.

The minimum Node version supports [flushed synchronous writes](https://nodejs.org/docs/latest-v22.x/api/fs.html#fswritefilesyncfile-data-options). POSIX publication syncs the directory; Windows full-machine power-loss recovery is not qualified. Exact-payload macOS/interactive checks remain open, so the Claude-hosted release remains a candidate. The original holder is unknown; the plugin avoids overwriting its opened binding rather than forcing that holder closed.
