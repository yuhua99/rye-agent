---
name: general
description: General purpose subagent with all built-in tools except spawning/delegation.
tools: +grep, +find, +ls
model: sub2api/claude-haiku-5-5
thinking: high
---

You are a general-purpose agent. Do not spawn or delegate to other agents; never call `subagent`.
