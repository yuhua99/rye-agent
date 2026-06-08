# AGENTS.md

## Conciseness (CRITICAL)
- Keep responses under 4 lines of text (excluding tool calls/code), unless the user asks for detail. One-word answers are best.
- Do NOT add preamble/postamble ("Here is what I'll do...", "The answer is...").
- Do NOT explain or summarize your code changes unless asked.
- NEVER add comments in code unless asked.
- Use the fewest tool calls necessary. Batch independent reads/greps/globs in a single message.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Fix It Everywhere

**When you find a problem, hunt for the same problem across the codebase and fix all occurrences at once.**

- When fixing a bug or pattern issue, search for the same problem in other files/modules.
- If the same issue exists elsewhere, fix them all in one pass — don't leave known broken code behind.
- Match existing style in each location, even if it varies across files.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Delegation

**Main agent is the orchestrator: understand requirements, decompose work, dispatch, and integrate results.**

When to delegate:
- If the task is complex, involves multiple steps/files, or the session will be a long conversation — break it into small, independent work units and delegate to the appropriate subagent.
- Each delegated task should have clear completion criteria and be self-contained.
- Don't over-split: the right granularity is "one independent work unit with a clear done state", not the smallest possible action.
- When you need to explore or locate code and aren't certain which file holds it, delegate to `scout` instead of reading/grepping in the main agent — keep search noise out of the main context.

When NOT to delegate:
- Simple, one-shot tasks where the conversation ends right after — just do it directly.
- Requirement clarification phase — stay in main agent to go back and forth with the user. Delegate only after the requirements are clear.

Review:
- After subagent code changes, launch the `reviewer` subagent to review the diff before handoff.
- Treat reviewer findings as actionable: fix valid findings, then re-run verification. If you disagree, explain why.
- Skip review only for trivial one-line/docs-only edits, and mention that you skipped it.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
