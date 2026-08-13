# AGENTS.md

## Conciseness
Default: short answers. Result only. Explain or summarize on request.
Expand for design, tradeoffs, review, or when asked for an opinion.
Comments, docstrings, TODOs only when requested or required by repo tooling. Leave existing comments unless the change makes them wrong.
Batch independent reads/greps/globs in one message.

## Ambiguity
Surface it. Name interpretations and ask, or state the assumption before coding. Push back when a simpler path exists.

## Simplicity
**Minimum code. Asked path only.** First rung that holds:
1. Build nothing? (YAGNI)
2. Stdlib, platform, or an installed dependency already does it? Use it.
3. One direct expression? Start there.
4. Only then: write it.

Happy path first. Branch, abstract, validate, or catch only for a concrete contract, trust boundary, convention, failing test, or bug, and catch to recover, translate to a domain error, or add actionable context.
Match surrounding code.

## Fix It Everywhere
Search, state the scope, wait for agreement, then fix agreed hits in one pass, matching each location's style.

Remove only unused bindings your change created.

The test: every changed line traces to the user's request.
