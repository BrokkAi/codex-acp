# Merge upstream and prepare 1.14.0

Merge origin/main 7524e97 into existing main, retaining BrokkAi publication and client contracts. Use upstream SDK 2.0 routing, standard subagents, recovery and instructions; integrate fork behavior on those structures. Pin Codex to upstream lock resolution 0.164.0. Regenerate lock and golden snapshots, inspect behavior changes, pass npm ci/typecheck/test/build/pack, commit locally with required coauthor. No push, tags, publication, or deletion of existing tarballs.

Progress: inspected prior merge and fork history; merge conflicts being reconciled.

## Resolution decisions

Use upstream's v1/v2 router and keep private child-cancel registration in that router. Use upstream's baseline/leftover observers with session-owned interaction lifetimes for approvals and asynchronous question forms; retain fork execution/goal snapshots and guard cleanup from erasing autonomous work. Use upstream MCP normalization with the explicit per-server policy mapped at its shared config boundary. Keep fork turn attribution/coverage while adopting upstream cache semantics, inherited-history baselines and reset fallback. Use native ordinary goal continuations, preserving identity-checked Mj recovery. Use upstream live/replayed standard children beside AIR children, retaining AIR cancellation generations. Keep publication workflow and deleted release automation; regenerate lockfile and goldens.

Focused tests passed: usage/instruction/goal 188; async/child models/goal/supervisor 99; real pinned-Codex prompt + trusted hook replacement + provider paths 16. Full verify sequence and full real-process integration suite running. Hook test confirms Mj precomputed hash compatibility and untrusted siblings across replacement. Goal origin stays omitted, as upstream, and is not claimed to provide user provenance.

## Completed validation

The final clean sequence npm ci, npm run typecheck, npm test, npm run build and npm pack passed. Unit suite: 142 files passed, 7 skipped; 2,115 tests passed, 40 skipped. Full real-process integration: 7 files and 18 tests passed. Codex is pinned to 0.164.0; SDK range is ~2.0.2 (lock resolves 2.0.2). The source is frozen and scenario snapshots are regenerated. Upstream's accumulator is now the single aggregation owner; the fork wrapper only adds turn attribution and coverage. Test process configuration is isolated centrally for all launchers. The output brokkai-codex-acp-1.14.0.tgz remains in the repository root alongside all existing tarballs. No publication is performed.
