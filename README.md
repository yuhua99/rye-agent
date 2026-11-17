# rye-agent

Personal Pi setup: `/handoff`, `/commit`, the `ansi-dark` theme, `AGENTS.md`, and agent definitions for [pi-subagent](https://github.com/yuhua99/pi-subagent).

## Install

Remove any existing `~/.pi/agent/AGENTS.md` and `~/.pi/agent/agents` first.

```bash
pi install git:github.com/yuhua99/rye-agent@package
pi install git:github.com/yuhua99/pi-subagent@herdr
pi install git:github.com/yuhua99/pi-quiet
pi install git:github.com/yuhua99/pi-web
pi install git:github.com/yuhua99/pi-usage
R=~/.pi/agent/git/github.com/yuhua99/rye-agent
ln -s "$R/AGENTS.md" ~/.pi/agent/AGENTS.md
ln -s "$R/agents" ~/.pi/agent/agents
```

Add to `~/.pi/agent/settings.json`:

```json
"defaultTools": ["+codemode"],
"codemode": { "mode": "only" }
```

## Update

```bash
pi update --extensions
```

## Develop

Pi resets its checkout on update, so edit in a separate clone:

```bash
git clone -b package git@github.com:yuhua99/rye-agent.git ~/src/rye-agent
pi remove git:github.com/yuhua99/rye-agent
pi install ~/src/rye-agent
ln -sfn ~/src/rye-agent/AGENTS.md ~/.pi/agent/AGENTS.md
ln -sfn ~/src/rye-agent/agents ~/.pi/agent/agents
```
