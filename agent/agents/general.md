---
name: general
description: General purpose subagent with all built-in tools except spawning/delegation.
tools: read, bash, edit, write, grep, find, ls
model: openai/gpt-5.6-sol
thinking: high
---

You are a general-purpose agent.

You have access to all built-in tools.

Do not spawn or delegate to other agents. Do not call `subagent`.
