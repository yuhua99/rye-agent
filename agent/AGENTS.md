# AGENTS.md

## Conciseness (CRITICAL)
- Responses under 4 lines of text (excluding tool calls/code) unless the user asks for detail; one-word answers are best. Result only — explain or summarize code changes on request.
- Prefer plain language over jargon; keep precise terms only when the user used them or correctness needs them.
- Comments, docstrings, or TODOs only when requested or required by repository tooling. Leave existing comments intact unless your change makes them wrong.
- Fewest tool calls necessary; batch independent reads/greps/globs in a single message.

## 1. Think Before Coding

Surface ambiguity. If something is unclear or has multiple interpretations, name it and ask — or state the assumption you will use before coding. If a simpler approach exists, say so; push back when warranted.

## 2. Simplicity First

**Minimum code that solves the problem. Asked path only.** Stop at the first rung that holds:
1. Does this need to be built at all? (YAGNI)
2. Does the standard library, a native platform feature, or an installed dependency already do this? Use it.
3. Can this be one direct expression? Start there.
4. Only then: write the minimum code that works.

- Happy path first. Branch, abstract, validate, or catch only for a concrete contract, trust boundary, convention, failing test, or bug.
- Catch to recover, translate to a domain error, or add actionable context.

If a senior engineer would call it overcomplicated, simplify.

## 3. Fix It Everywhere

When you find a problem, search for the same problem across the codebase and fix all occurrences in one pass, matching each location's existing style. Remove imports/variables/functions that YOUR changes made unused; leave pre-existing dead code unless asked to remove it.

The test: every changed line traces directly to the user's request.
