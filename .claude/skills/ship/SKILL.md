---
name: ship
description: The end-to-end ticket workflow for gomidas — claim a Samu ticket, plan it, implement on a branch, pass the four verification gates, open a PR, review it, and merge with the user's approval. Use whenever picking up or finishing a GMD ticket, or when asked to "work on GMD-<n>", "ship this ticket", "what's next". One ticket, one branch, one PR.
---

# ship — one ticket, one branch, one PR

The workflow for landing work on gomidas. **Do not skip stages and do not reorder them.**
Every stage that can fail sends you *backwards*, not forwards.

```
1 CLAIM → 2 PLAN → 3 BRANCH → 4 IMPLEMENT → 5 VERIFY → 6 PR → 7 REVIEW → 8 MERGE → 9 CLOSE
              ↑                    ↑              │             │            │
              └────────────────────┴──────────────┴─────────────┘            │
                        any failure goes back, never forward           user approves
```

Two hard stops where you **must** wait for the user: the plan (stage 2) and the merge (stage 8).
Everything else you drive yourself.

## When this workflow does NOT apply

**Meta-work on the tooling itself — skills, `CLAUDE.md`, `.gitignore`, harness config — goes
straight to `main` when the user asks for it.** No branch, no PR, no review. It isn't a GMD
ticket, the verification gates have no code to check, and a PR round-trip on a workflow file
buys nothing. This is the user's standing call (2026-08-17); it is not a licence to skip the
loop for anything that touches `src/`, `packages/`, or `apps/`.

Still log it to Samu (`samu status log`) — the board should show the tooling changing too.

Everything else — every GMD ticket, every code change — goes through all nine stages.

---

## 1. CLAIM

```bash
samu ticket ls                    # what's open
samu ticket show GMD-70           # the one you're taking
samu ticket move GMD-70 "In Progress"
```

If the user named a ticket, take it. If they said "what's next", propose one from `Todo` by
priority and let them confirm before claiming. Follow the **`samu` skill** for tracker rules.

Start from a clean, current base:

```bash
git status --porcelain            # must be empty
git checkout main && git pull
```

## 2. PLAN — and stop

**Call `EnterPlanMode` FIRST — before reading the code, not after.** Read the ticket, then enter
plan mode, then explore. Doing the exploration first and only then entering plan mode wastes a
round trip: plan mode has its own read-only exploration phase, and you end up re-entering it with
the work already done. Ticket → `EnterPlanMode` → read → plan → `ExitPlanMode`.

Inside plan mode: read the code the ticket touches, then present a short plan — what changes,
which files, how you'll verify it — and **wait for approval** via `ExitPlanMode`.

Ask now, not later, about anything where two readings lead to materially different work. A
question asked before the branch costs a message; asked after the PR it costs the PR. If the
ticket body is ambiguous, say which reading you're taking.

Check `CLAUDE.md` for what's already known about the area — most of this repo's traps are
written down (bank selection, three instrument factories, `snapshotMix`, the alphaTab rAF
bootstrap, `AudioParam.value` on web). Re-deriving one of those is wasted work.

**Measure anything you're about to assert.** GMD-68's plan carried the runtime, the diagnostic
histogram and the file-set delta, so the CI placement and the fatal-code set were decisions
rather than guesses — and the one claim taken from a single measurement rather than reasoned
through ("TS2552 is zero, so it can't matter") was the one the review overturned.

## 3. BRANCH

```bash
git checkout -b gmd-70-title-overprint       # gmd-<n>-<short-slug>, lowercase
```

## 4. IMPLEMENT

Normal work. Commit in logical chunks, and **put the ticket key in every commit subject**:

```
GMD-70: serialize addTrack and selectTrack so their renders don't overlap
```

If you discover a bug that isn't this ticket, **file it** (`samu ticket create …`) and keep
going. Don't widen the branch — one ticket, one PR.

## 5. VERIFY — all four gates, before the PR exists

A PR is a claim that the change works. Run these from the repo root. If any fails, **go back to
stage 4**; if the fix invalidates the plan, back to stage 2.

**Gate A — automated.** All four must be green:

```bash
pnpm install                                     # if lockfile/deps moved
pnpm typecheck
pnpm test                                        # vitest (builds core first)
cmake -B build -DCMAKE_BUILD_TYPE=Debug -DGOMIDAS_BUILD_TESTS=ON
cmake --build build --target gomidas_tests && ctest --test-dir build --output-on-failure
```

The desktop app itself must also still build — `cmake --build build`. The standing rule is that
**every commit leaves `cmake --build build` green and the macOS app behaving identically**.

**Gate B — the dangling-reference sweep.** `app.js` / `editor.js` / `fretboard.js` / `grooves.js`
/ `core/gomidas-core.js` are plain `<script>` globals with no typecheck, so a dangling reference
is invisible until that line runs (this is what shipped GMD-67's silent note audition for a day):

```bash
pnpm sweep   # 0 = clean · 1 = you referenced something that doesn't exist · 2 = it checked NOTHING
```

**Exit 2 is not a pass.** It means the sweep couldn't do its job — a stale or empty `files` list, a
plain-JS file the build compiles that nobody added to it, tsc killed, tsc missing. Treat 2 as
harder than 1: on a 1 you have one bug; on a 2 you have no coverage.

No counting by eye any more (GMD-68): the two real globals are declared in
`packages/core/types/globals.d.ts`, so **any** surviving `TS2304`/`TS2552` is a real bug and the
script fails on it. Runs in ~0.3s and **also runs in CI**, first in the `web-tests` job. If it
names a legitimate new global from another `<script>` tag, declare it in `globals.d.ts` — never
delete the check.

⚠️ **A green sweep is not "every reference resolves."** It sees **bare identifiers** only.
Cross-file calls in these files mostly go via `window.<name>`, and a missing property on `window`
is TS2339 — 472 of those exist as noise, so they can't gate. Renaming a `window.gomidas*` entry
point passes a green sweep. GMD-67 was a bare identifier, which is why this catches it.

**Gate C — runtime verification.** Build green ≠ works. Actually exercise the change and keep
the evidence for the PR body. Pick by what you touched:

- **Web UI/editor** → `pnpm web:dev`, drive it in Chrome, check the console. Remember the editor
  serves compiled `dist/core/*.js`: a tab left open across a build runs the OLD code.
- **Desktop** → `cmake --build build && open build/Gomidas_artefacts/Debug/Gomidas.app`, or run
  the binary directly (`.../MacOS/Gomidas`) with stderr captured when you need logs.
- **Audio** → don't trust your ears through a hidden tab. Stub `GomidasFiles.saveData` to
  capture, call `GomidasAudio.startRecording()` (the offline bounce), analyse the WAV. It's
  deterministic and it exercises the real instrument path.
- **Anything measurable (perf, levels, timing)** → measure it. This project's rule is
  *measure, don't guess*, and the numbers belong in the PR.

If a change genuinely can't be runtime-verified here (GUI-only routing, hardware), **say so
explicitly in the PR body** — don't let it pass silently.

**Gate D — both products.** `packages/core` is shared. A change can land on one product and
break the other; GMD-44, GMD-57 and GMD-62 all had exactly that shape. Ask: does this touch
shared core? If yes, verify **web and desktop**, and check whether a parallel code path exists
that needs the same fix (the three instrument factories, `bankFor`, `snapshotMix`,
`makeInstrument`).

## 6. PR

```bash
git push -u origin gmd-70-title-overprint
gh pr create --base main --title "GMD-70: <what changed>" --body "$(cat <<'EOF'
## Ticket
GMD-70 — <title>

## What changed
<2-4 bullets, mechanism not narration>

## Verification
- Gate A: typecheck / vitest / cmake / ctest — green
- Gate B: sweep clean (only the 2 known globals)
- Gate C: <what you actually ran, and what you observed — numbers if measurable>
- Gate D: <web + desktop, or "core untouched">

## Notes
<risks, follow-up tickets filed, anything deliberately left out>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

CI runs on `pull_request` (web-tests + native-tests). **Wait for it and confirm it's green** —
`gh pr checks --watch`. Red CI → back to stage 4.

## 7. REVIEW

Run the review skill against the PR **at `high`**:

```
/code-review high <PR#>
```

**Always pass the level explicitly.** With no level, the skill reuses whatever was typed last —
possibly in an unrelated session — which makes the strictness of this gate non-deterministic.
`high` is the level that goes looking *outside* the diff for parallel code paths, which is where
this repo's expensive bugs live (GMD-44's three instrument factories, GMD-57's duplicated
`bankFor`, GMD-62/66's hand-rebuilt mixer). A high-confidence-only pass approves all of those.

Then **triage every finding honestly**. Fix what's real. For anything you disagree with, say why
in one sentence rather than silently dropping it. A fix means **re-running stage 5's gates** —
at minimum the ones the fix could plausibly break — then push and confirm CI again.

**Verify a suggested fix before adopting it.** A finding can be right about the problem and wrong
about the remedy: GMD-68's review proposed `ts.readConfigFile` for JSONC parsing, but TypeScript 7
is the native port and its package exposes only `version` — no compiler API to call. Checking took
one command; adopting it blind would have broken the gate.

Loop 7 → 4 → 5 → 7 until the review comes back clean. Only then go to stage 8.

**Expect more than one round, and don't stop at the first clean-looking one.** GMD-68 took three:
15 findings, none in the feature, all in the gate — four of them cases where it reported success
having checked nothing. Stop when the findings are about wording rather than correctness, and
**say in the merge ask which round you stopped at and why**.

⚠️ **`ultra` is on the user's demand ONLY.** Never run it, never propose it, never suggest a
change is "risky enough to deserve ultra". It is billed and user-triggered — if they want the
deep multi-agent pass they will ask for it, and only then does it enter the loop.

## 8. MERGE — stop and ask

**Never merge on your own initiative.** Present:

- the PR link,
- what it does in a couple of lines,
- the verification evidence (the four gates),
- the review outcome, including anything you pushed back on.

Then ask the user to review and approve. On their go-ahead:

```bash
gh pr merge <PR#> --squash --delete-branch     # or --merge if they prefer the merge commit
git checkout main && git pull
```

## 9. CLOSE

Only after the merge is actually on `main`:

```bash
samu ticket move GMD-70 "Done"
samu status log --project GMD --health on_track -m "GMD-70: <what landed>, verified by <how>."
```

**Done means it works**, not that it compiled. If it merged but is unverified, leave it In
Progress and say why — `at_risk`/`off_track` with the reason.

Last: did this teach a **standing rule** — a trap that would cost the next person a day? Then
add it to `CLAUDE.md` (that's the file loaded every session; a Samu comment isn't). Per-ticket
detail stays in Samu. And keep `docs/FEATURES.md` / `docs/BACKLOG.md` current when a feature
lands.

---

## Rules that hold across the whole loop

- **One ticket, one branch, one PR.** Scope creep goes to a new ticket, not this branch.
- **Failures go backwards.** Never open a PR on a red gate, never merge on a red review, never
  mark Done on an unverified merge.
- **The two hard stops are the plan and the merge.** Everything between them is yours to drive.
- **`main` is always green.** Every commit leaves `cmake --build build` building and the macOS
  app behaving identically.
- **Report faithfully.** If a gate was skipped, say which and why, in the PR body and to the
  user. A quietly skipped gate is worse than a failed one.
