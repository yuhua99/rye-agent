# AGENTS.md

## Conciseness
- Default: short answers. Result only — explain or summarize changes on request.
- Expand when the work is design, tradeoffs, review, or the user asks for an opinion.
- Prefer plain language; keep precise terms only when the user used them or correctness needs them.
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

## 3. Fix It Everywhere

When you find a problem, search for the same problem. State the scope first; do not expand beyond the current hit unless the user agrees. Then fix agreed occurrences in one pass, matching each location's existing style.

Remove imports/variables/functions that YOUR changes made unused; leave pre-existing dead code unless asked to remove it.

The test: every changed line traces directly to the user's request.
