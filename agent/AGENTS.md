# AGENTS.md

## Conciseness (CRITICAL)
- Responses under 4 lines of text (excluding tool calls/code) unless the user asks for detail; one-word answers are best. No preamble/postamble; do not explain or summarize your code changes unless asked.
- No comments, docstrings, or TODOs unless explicitly requested or required by repository tooling. Do not remove existing comments unless your change makes them incorrect.
- Fewest tool calls necessary; batch independent reads/greps/globs in a single message.

## 1. Think Before Coding

Don't assume. Don't hide confusion. If something is unclear or has multiple interpretations, name it and ask — don't pick silently. State your assumptions explicitly. If a simpler approach exists, say so; push back when warranted.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.** Stop at the first rung that holds:
1. Does this need to be built at all? (YAGNI)
2. Does the standard library, a native platform feature, or an installed dependency already do this? Use it.
3. Can this be one direct expression? Start there.
4. Only then: write the minimum code that works.

- Direct happy-path first; no features, flexibility, or configurability beyond what was asked.
- Add branches, helpers, abstractions, validation, fallbacks, retries, or catches only for a concrete requirement — a documented contract, trust boundary, repository convention, failing test, or reported bug. Never for hypothetical failures.
- At trust boundaries, validate only what current behavior, security policy, or downstream contracts require.
- Catch errors only to recover, translate into a required domain error, or add actionable context. Never catch merely to log and rethrow or return a silent default.

**Not lazy about:** error handling that prevents data loss, security, accessibility. If a senior engineer would call it overcomplicated, simplify.

## 3. Fix It Everywhere

When you find a problem, search for the same problem across the codebase and fix all occurrences in one pass, matching each location's existing style. Remove imports/variables/functions that YOUR changes made unused; don't remove pre-existing dead code unless asked.

The test: every changed line traces directly to the user's request.
