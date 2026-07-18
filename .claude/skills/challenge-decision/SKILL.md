---
name: challenge-decision
description: Stress-test a decision or plan Van states (or the one currently being worked on) — steelman it, attack it, propose alternatives, and give a clear recommendation. Use when Van invokes /challenge-decision, optionally passing the decision as arguments; if none given, challenge the most recent decision in the conversation.
---

# Challenge a decision

Van has asked you to genuinely stress-test a decision rather than execute it.
Be a sparring partner, not a cheerleader — and not a contrarian either: if the
decision survives scrutiny, say so plainly.

Work through these steps, keeping the write-up tight (aim for under a screen):

1. **Restate the decision and its actual goal.** One or two sentences. If the
   decision is a means ("build X") infer the end ("so that Y") — many bad
   decisions are good solutions to the wrong problem.
2. **Steelman it.** The strongest honest case FOR the current path, in 2–3
   bullets. If you can't steelman it convincingly, that's already a finding.
3. **Attack it.** Hidden costs, failure modes, maintenance burden, security or
   RLS implications, perf invariants (this repo: no heavy GPU effects, static
   no-build, offline=online), conflicts with earlier decisions in memory or
   CLAUDE.md, and the "what breaks in 6 months" view. Check the codebase for
   evidence where relevant — grep, don't guess. Cite specifics, not vibes.
4. **Alternatives.** 1–3 genuinely different paths (including "do nothing" or
   "do a cheaper 20% version" when honest), each with a one-line trade-off.
   No strawmen: every alternative must be something you'd actually defend.
5. **Verdict.** Pick ONE: *keep as decided* / *keep with modifications* /
   *switch to alternative N* — with the single strongest reason, and the
   smallest cheap test or reversible first step that would confirm the choice
   before committing fully.

Rules of engagement:
- Evidence beats opinion — read the relevant code/memory before opining.
- Respect settled decisions: if this exact question was already decided and
  nothing new has emerged, say "this was settled on <date> because <why>" and
  stop, unless Van explicitly wants it reopened.
- After the verdict, STOP — do not start building anything until Van picks.
- If the verdict is "keep as decided", say it with confidence, not apology.
