# AGENTS.md

## Conciseness (CRITICAL)
- Keep responses under 4 lines of text (excluding tool calls/code), unless the user asks for detail. One-word answers are best.
- Do NOT add preamble/postamble ("Here is what I'll do...", "The answer is...").
- Do NOT explain or summarize your code changes unless asked.
- Do not add comments, docstrings, TODOs, or explanatory annotations unless explicitly requested or required by existing repository tooling.
- Do not remove existing comments unless your change makes them incorrect.
- Use the fewest tool calls necessary. Batch independent reads/greps/globs in a single message.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative. The best code is the code never written.**

Before writing any code, stop at the first rung that holds:
1. Does this need to be built at all? (YAGNI)
2. Does the standard library already do this? Use it.
3. Does a native platform feature cover it? Use it.
4. Does an already-installed dependency solve it? Use it.
5. Can this be one direct expression? Start there.
6. Only then: write the minimum code that works.

- Start with the direct happy-path implementation.
- No features, flexibility, or configurability beyond what was asked.
- Add branches, helpers, abstractions, validation, fallbacks, retries, or catches only for a concrete requirement.
- Do not handle hypothetical failures. Each handled case must come from a documented contract, trust boundary, repository convention, failing test, or reported bug.
- At trust boundaries, validate assumptions required by current behavior, security policy, or downstream contracts; do not validate unrelated possibilities.
- Catch errors only to recover, translate them into a required domain error, or add actionable context. Never catch merely to log and rethrow or return an undocumented or silent default.
- If you write 200 lines and it could be 50, rewrite it.

**Not lazy about:** error handling that prevents data loss, security, accessibility. Non-trivial logic leaves ONE runnable check behind — no frameworks, no fixtures.

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
