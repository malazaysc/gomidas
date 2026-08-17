---
name: samu
description: Use Samu — this project's issue tracker — whenever you pick up, progress, finish, or discover work. Samu is the source of truth for WHAT to work on and its state, replacing GitHub Issues for gomidas. Trigger on "what should I work on", "next task", "pick up a ticket", starting/finishing any feature or bugfix, finding a new bug, or "log status". Drive it with the `samu` CLI (already authenticated as the coding-agent via SAMU_CONFIG); one command per action, no big tool schemas in context.
allowed-tools: Bash(samu:*)
---

# Samu — the gomidas work tracker

Gomidas tracks all work in **Samu**, a local issue tracker. A human watches a live board;
you keep it current so they see progress without interrupting you, and so parallel agents
don't collide. **Samu is the source of truth** — work from what's on the board, not from your
own memory or from `docs/BACKLOG.md` (the backlog is now a design doc; open work lives in Samu).

You are already authenticated as the **coding-agent** actor: the `SAMU_CONFIG` env var points
at `.samu/config.json` (server + token + workspace=`gomidas`), so every `samu` command below
just works. Everything you file/move is attributed to the agent on the board.

## The loop — do this as you work, not only when asked

1. **Before starting**, see what's open and pick up work:
   ```bash
   samu ticket ls                       # the board (all open tickets, newest first)
   samu ticket ls --status Todo         # filter by column
   samu ticket show GMD-8               # full detail of one ticket
   ```
2. **When you start a ticket**, claim it — move it to In Progress:
   ```bash
   samu ticket move GMD-8 "In Progress"
   ```
3. **When you discover work that isn't tracked** (a bug, a follow-up), file it — don't leave it
   only in your head or in chat:
   ```bash
   samu ticket create --project GMD --type bug --priority high --severity s2 \
     --repro-steps "1. … 2. … Expected: … Actual: …" \
     "Kit hotspots misaligned when stage is narrow" \
     --body "Why / Mechanism / Where (file:line) / How to verify / Traps"
   # types: feature | bug | task | chore   priorities: none | low | medium | high | urgent
   ```
   **Use the structured fields — they're easy to forget.** `--severity` (s1|s2|s3|s4),
   `--repro-steps` and `--found-in-version` are **bugs only**; `--estimate` (integer points)
   works on any type. A bug filed with the repro in the body instead of `--repro-steps` loses
   it to free text.

   For anything bigger than a one-line finding, don't hand-roll the ticket — use the
   **`spec` skill**, which researches the code first and writes bodies an agent can act on cold.
   Small note on an existing ticket instead? `samu ticket comment GMD-8 -m "…"`.
4. **When you finish a chunk, change plan, or hit a blocker**, update the ticket and log status:
   ```bash
   samu ticket move GMD-8 "Done"                 # only when actually verified (see below)
   samu status log --project GMD --health on_track -m "Multirest shipped; verified on a 12-bar score."
   # health: on_track | at_risk | off_track   — a blocker is at_risk/off_track; say WHY.
   ```

## Rules that keep the board trustworthy

- **Never move a ticket to Done until the change is actually verified** (built + exercised), not
  just written. A human reads Done as "it works."
- **A blocker is `at_risk` (or `off_track`), and the status body must say why** — silence reads
  as "on track."
- **File findings the moment you see them.** The cost of a stray ticket is tiny; the cost of a
  lost bug is a human re-discovering it later. If you're unsure whether to file — file it.
- **Reference the ticket key in your commits/PRs** (e.g. `GMD-8: multirest merge`) so code and
  tracker stay linked.
- **Don't re-file what's already there.** `samu ticket ls` / `samu ticket show` first; if a
  matching ticket exists, update it instead of creating a duplicate.

## Board columns

`Backlog → Todo → In Progress → Done`. New tickets land in the first open column. Move with
`samu ticket move <KEY> "<Column>"` (exact column name, quoted).

## When something errors

- `resource not found` on a ticket usually means a wrong key or wrong workspace — check
  `samu ticket ls` (workspace is `gomidas`, keys are `GMD-<n>`).
- Auth errors mean `SAMU_CONFIG` isn't set or the server is down — surface that, don't retry
  blindly. The server is `http://127.0.0.1:8080` (`curl -s $_/health`).

## More than the core loop

`samu --help` (and `samu <verb> --help`) is your on-demand reference — it lists milestones,
labels, docs, features, and test-plan verbs beyond the loop above. Reach for them only when a
task calls for it; the five verbs above cover almost everything day to day.
