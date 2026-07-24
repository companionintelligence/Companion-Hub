---
name: agent-sweep
description: Scan recent CI-Hub commits for cross-commit gotchas. Use before end-of-shift or after multi-commit sessions.
---

# Agent Sweep — CI-Hub

## Run

```bash
bin/agent-sweep --since 1.day --count 20
```

## Analyze

The script prints a sweep prompt. In this session:

1. Run `git log --since=1.day -p -n 20` (adjust window as needed)
2. Look for:
   - Inconsistent patterns across commits
   - Partial fixes leaving dead code or stale docs
   - Missing tests for behavior changes
   - `docs/system/*.md` drift vs code
   - Security or perf regressions spanning commits
3. Read [docs/agent/CODING_CONVENTIONS.md](../../docs/agent/CODING_CONVENTIONS.md)
4. Report Critical / Warning / Suggestion with file paths

Do not implement fixes unless asked — report only.
