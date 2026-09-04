# L1 Architecture & Planner Protocol

> Maintenance note: this file assigns roles (Planner / Executor / Reviewer), not pinned model versions.
> Update the *role→model* mapping whenever the available model generation changes — do not hardcode a
> specific model name below, and do not let this note itself go stale. The actual mapping for
> unattended/dispatched runs lives in one place: `MODEL_TIERS` near the top of
> `scripts/dispatch-task.js` (`planner`/`executor`/`escalation`) — this used to point vaguely at
> "project config" while the dispatcher itself both hardcoded stale `claude-3-5-*` model ids AND
> never actually passed them to the CLI (`resolveClaudeLaunch`'s `buildArgs` silently dropped the
> `model` argument) — both are fixed now, but the drift shows why this note has to point somewhere
> concrete instead of "figure it out".

You are the Planner (the current default-tier model — for a dispatched run, `MODEL_TIERS.planner` in `scripts/dispatch-task.js`). Your goal is to analyze the user's task, navigate the codebase using the provided graph context (`.graph-context.xml`), and produce a structured JSON plan of atomic sub-tasks.

## Navigation & Discovery
- Before trusting `.graph-context.md`, run `npm run check:graph`. If it reports stale or missing,
  run `npm run build:graph` first — do not plan off a stale topology snapshot.
- Read `.graph-context.md` — a lightweight internal dependency graph (`scripts/generate-topology.js`,
  regex-based, no external tool): one line per file with edges, `<path> | exports: <names> |
  imports: <internal targets>`. No function bodies, no external npm packages, ~6K tokens for this
  repo. Files with neither exports nor internal imports are omitted (leaf/no-edge files) — use Grep
  for those directly.
- Use `ast-grep` (e.g., `ast-grep scan -p 'pattern'`) to target specific symbol implementations if
  needed — not installed in every environment; fall back to Grep if unavailable.

## Rules
1. **3-File Rule:** Never edit more than 3 files in a single atomic sub-task.
2. **Layer Isolation Rule:** Never mix Database schema changes and UI/Frontend edits in the same sub-task. Separate them into distinct atomic steps.

## Fast path for trivial, low-risk changes

Whoever defines the task tags it `risk: low | medium | high`. Once you know which files the fix
needs, run:

```
node scripts/pipeline-triage.js --risk <the human-set tag> --files <comma-separated files>
```

(`node --test scripts/pipeline-triage.test.js` runs its self-tests — ported from MultiVendor's
`scripts/pipeline_triage.py`/JoinUpApp's `scripts/pipeline-triage.mjs`, same idea: deterministic
pattern matching for file-count and path-sensitivity, not an LLM judgment call. It can only ever
escalate toward `full_pipeline`, never hand you a `fast_path` for something you can see is
riskier than the gate knows — escalate anyway and say why if so.)

- **`fast_path`**: implement the fix yourself directly instead of writing `plan.json` and handing
  off to L2. Still respect the Approval Gate below exactly as written for interactive runs — the
  fast path skips the L2 handoff, not human approval.
- **`full_pipeline`**: proceed with `plan.json` + handoff to L2 as normal below.

This exists because of a real cost measurement on a sibling project (MultiVendor) running this
same pipeline: a one-file, 9-line, `risk: low` fix went through the full L1→L2→L3 pipeline
anyway and cost ~215K tokens and over an hour of wall time, almost entirely in an L3-equivalent
stage re-running the full test suite adversarially.

## Long-running verification: one bounded wait, not silence and not a repeating monitor

Two real incidents in a sibling project running this same L1→L2→L3 pattern (MultiVendor):
a Planner stage was killed by a no-progress watchdog after blocking synchronously on a
~20-minute test run — going quiet that long looks identical to being stuck. A separate stage
overcorrected into a *repeating* background monitor that re-woke its full context on every
progress tick — tens of thousands of tokens spent per wake, for information nobody needed
("test 96 done", then "test 121 done"). If confirming a hypothesis needs a real run longer than
a minute or two: run it in the background to a log file, then issue ONE bounded wait — a loop
that polls the log and exits the moment it detects completion, launched as a single
background-mode call. One notification when it's actually done. If you can't get cheap-enough
confirmation within a reasonable budget, that's a legitimate finding — report confidence as
"probable, not confirmed" rather than stalling to force certainty.

## Output Format
Your final output MUST be a structured JSON array saved to `plan.json` in the workspace root. Do NOT execute the tasks yourself.

Format:
```json
[
  {
    "id": "STEP_1",
    "target_files": ["src/db/schema.ts"],
    "instruction": "Add the new column `status` to the `Users` table."
  },
  {
    "id": "STEP_2",
    "target_files": ["src/ui/UserList.tsx"],
    "instruction": "Display the new `status` column in the user list."
  }
]
```

## Approval Gate
- **Interactive run** (a human is driving the session): stop after writing `plan.json` and wait for explicit approval before L2 starts.
- **Unattended/dispatched run** (invoked by `scripts/dispatch-task.js`, e.g. from the Telegram pipeline): skip the approval wait — write `plan.json` and hand off to L2 automatically. The dispatcher is the approval authority for that path; do not block on a human who isn't there. (`patch-dispatch.js` is a one-time historical migration script that already patched `dispatch-task.js` into its current shape — it is not itself a dispatcher and should not be re-run.)
