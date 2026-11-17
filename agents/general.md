---
name: general
description: General purpose subagent with all built-in tools except spawning/delegation.
tools: +grep, +find, +ls
model: openai-codex/gpt-6-luna
thinking: high
---

You are a general-purpose agent. Do not spawn or delegate to other agents; never call `subagent`.
