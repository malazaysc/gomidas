---
name: spec
description: Turn a rough idea or bug report into decided, agent-ready Samu tickets for gomidas — research the codebase first, discuss until the open questions are settled, then file tickets sized to one /ship run each. Use when the user describes something they want built, reports a bug, or says "I have an idea", "let's plan X", "spec this out", "what would it take to…". The front door of the pipeline; /ship is the exit.
---

# spec — idea in, agent-ready tickets out

The front half of the pipeline. `/ship` consumes tickets; **this is what produces them.**

```
1 GROUND → 2 DISCUSS → 3 DECIDE → 4 SPLIT → 5 FILE
   (read)     (ask)     (commit)   (size)   (samu)
```

A ticket is finished when an agent can pick it up cold and start work **without re-deriving
anything you already worked out here**. That standard is the whole point of the skill.

---

## 1. GROUND — read before you ask

**Never open with questions.** Gomidas has an unusually large written knowledge base; asking the
user what the repo already states is the fastest way to make this skill annoying and to produce
a ticket that contradicts the code.

In order:

1. **`CLAUDE.md`** — find the section covering this area. Most of this project's traps are
   already written down (bank selection, the three instrument factories, `snapshotMix`, the
   alphaTab rAF bootstrap, `AudioParam.value` on web, percussion channel detection). If a trap
   applies, it belongs in the ticket.
2. **The board** — `samu ticket ls`, and `samu ticket show` on anything that looks adjacent. If
   a matching ticket exists, **update it instead of filing a duplicate.** Related-but-distinct
   tickets get cross-referenced by key.
3. **The code** — for anything non-trivial, **fan out read-only `Explore` subagents in parallel**
   (the user has opted into this). Give each a narrow question, not a topic:
   - "Where is X implemented, and what are all the call sites?"
   - "Is there more than one code path that does Y? GMD-44/57/62 were all duplicated-logic bugs."
   - "What does the web build do here versus the desktop build?"
   Run them in one message so they go concurrently. For a small, well-understood change, skip
   the fan-out and just read the files — judge by scope, not by habit.

Come out of this with: where the work lands, what already exists, what will break.

## 2. DISCUSS — ask only what the code can't answer

Now ask. Legitimate questions are about **intent and judgement**, not facts:

- what the user actually wants to happen, in observable terms
- where the scope boundary sits — what's explicitly *not* in this
- UX/behavioural choices with no obviously right answer
- priority and urgency relative to what's already on the board
- for a bug: exact repro, what they saw versus expected, which build

**Batch the questions** (`AskUserQuestion`) rather than dripping them one per message. Offer a
recommendation when you have one — a default beats an open prompt.

Bring what you found in stage 1 into the discussion. "This touches `packages/core`, so it lands
on both products" or "there are three copies of this factory" is exactly the kind of thing that
changes what the user asks for, and they can't know it unprompted.

**Push back when the code says otherwise.** If the request rests on a wrong premise, say so in a
sentence and propose the nearest thing that works. That's cheaper here than in review.

**Stop asking when every remaining unknown could be resolved by the implementing agent from the
code itself.** Perfect certainty is not the bar; "no question left whose answer would change the
implementation" is.

## 3. DECIDE — say what was decided, and what was rejected

State the decision explicitly and get the user's agreement before filing. Include the
alternatives considered and **why they lost** — that reasoning is what stops the same debate
reopening in three weeks, and it goes in the ticket body.

## 4. SPLIT — one ticket = one `/ship` run

Size every ticket to **one branch, one PR, one review**. If a ticket can't plausibly be
implemented and verified in a single pass, split it — and say what each piece depends on.

Corollary: things discovered along the way that aren't this piece of work become **their own
tickets**, referenced from the first. Never widen a ticket to absorb them.

## 5. FILE — into Samu, directly

Once stage 3 has an agreed decision, **file the tickets** — no second approval round. Then show
the user the keys and titles so they can see what landed.

```bash
samu ticket create --project GMD --type bug --priority high --severity s2 \
  --repro-steps "1. … 2. … Expected: … Actual: …" \
  "Percussion was decided by MIDI channel, so a drum track off channel 10 played melodic garbage" \
  --body "$(cat <<'EOF'
…body per the template below…
EOF
)"
```

Flags worth using — `--type` (feature|bug|task|chore) · `--priority` (none|low|medium|high|urgent)
· `--severity` (s1–s4, **bugs only**) · `--repro-steps` (bugs only) · `--found-in-version` (bugs
only) · `--estimate` (integer points). See the **`samu` skill** for the tracker rules.

### Title: state the mechanism, not the symptom

The house style, and it's a good one. Compare:

- ❌ "Drum mix doesn't work"
- ✅ "Drum mixer fader scaled only a piece's first articulation"
- ✅ "Offline bounce ignores master gain, pan, EQ and master FX"

A title that names the mechanism tells the next reader whether it's their problem. A title that
names the symptom makes them open the ticket to find out.

### Body template

Drop sections that genuinely don't apply; don't drop them because they're work.

```markdown
## Why
<user-visible impact. Quote the user verbatim if they reported it — "drum mix does not
change anything" is worth more than a paraphrase.>

## Mechanism
<Bug: the causal chain, with exact identifiers and values — `renderKitMixer` keyed each
fader off `p.artics[0][1]`, so Hi-Hat moved 42 but not 46/44. Feature: how it should work
in terms of the architecture that exists.>

## Where
- `packages/core/fretboard.js:412` — <what lives here and why it matters>

## What changes
<the decision from stage 3, concretely. Include rejected alternatives + why they lost.>

## Acceptance
- [ ] <observable and checkable, not "works correctly">

## How to verify (Gate C)
<the specific thing to run or measure. Audio → the offline-bounce recipe (stub
`GomidasFiles.saveData`, call `GomidasAudio.startRecording()`, analyse the WAV) rather
than "listen to it". Numbers where numbers exist.>

## Traps
<relevant CLAUDE.md rules, and every parallel code path that must change together —
`bankFor`, `snapshotMix`, `makeInstrument`, the three instrument factories. This section
is why GMD-44 and GMD-62 had to be reopened.>

## Scope
Touches `packages/core` → verify web **and** desktop. / Core untouched.
Out of scope: <…> — filed separately as GMD-<n>.

## Open questions
<only if genuinely unresolved. Empty is the goal — an open question here means stage 2
stopped early.>
```

---

## The standard to hold

- **Research before questions.** Every question you ask that CLAUDE.md answers costs the user
  trust in the skill.
- **A ticket is agent-ready or it isn't.** The test: could someone who wasn't in this
  conversation run `/ship` on it and reach the same implementation? If they'd have to guess at
  something you already decided, the ticket is incomplete.
- **Name the traps.** This project's most expensive bugs were duplicated logic where one copy got
  fixed. If stage 1 found a second copy, the ticket says so.
- **One ticket, one `/ship` run.** Discoveries become new tickets, not a bigger one.
- **Don't invent scope.** If the user asked for a metronome accent, file that — not a metronome
  redesign. Adjacent ideas are follow-up tickets they can prioritise themselves.
