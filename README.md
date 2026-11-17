# rye-agent

Personal [Pi](https://pi.dev) setup, shared across machines as a Pi package.

| Path                    | Provides                                      | Loaded through |
| ----------------------- | --------------------------------------------- | -------------- |
| `extensions/handoff.ts` | `/handoff` command                            | Pi package     |
| `prompts/`              | `/commit` prompt template                     | Pi package     |
| `themes/`               | `ansi-dark` theme                             | Pi package     |
| `AGENTS.md`             | User instructions for every working directory | Symlink        |
| `agents/`               | Agent definitions for pi-subagent             | Symlink        |

## Install

```bash
pi install git:github.com/yuhua99/rye-agent@package
```

Drop `@package` once this branch is the default branch.

Pi packages cannot ship context files or agent definitions, so link those two into the agent directory. Move any existing `~/.pi/agent/AGENTS.md` and `~/.pi/agent/agents` out of the way first.

```bash
R=~/.pi/agent/git/github.com/yuhua99/rye-agent
ln -s "$R/AGENTS.md" ~/.pi/agent/AGENTS.md
ln -s "$R/agents" ~/.pi/agent/agents
```

- `agents/` is read by [pi-subagent](https://github.com/yuhua99/pi-subagent), which must be installed separately.
- The agent definitions name models as `provider/model`. Those providers must be configured on the machine; `models.json` is not part of this package.
- Select the theme with `"theme": "ansi-dark"` in `~/.pi/agent/settings.json`.

## Update

```bash
pi update --extensions
```

The symlinks point into the checkout Pi manages, so they follow the update.

## Develop

Pi resets its managed checkout on update, so do not edit files there. Clone the repository elsewhere, replace the git source with the local path, and point the symlinks at the clone. Keeping both sources installed loads `handoff` twice.

```bash
git clone -b package git@github.com:yuhua99/rye-agent.git ~/src/rye-agent
pi remove git:github.com/yuhua99/rye-agent
pi install ~/src/rye-agent
ln -sfn ~/src/rye-agent/AGENTS.md ~/.pi/agent/AGENTS.md
ln -sfn ~/src/rye-agent/agents ~/.pi/agent/agents
```
