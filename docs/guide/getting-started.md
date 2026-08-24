# Getting started

Two steps: get the binary, then turn it on in a repository. Both are short.

<!--@include: ../../README.md#install-->

## Turn it on in a repository

```bash
cd your-repo
parley init
```

That writes the adapter files — a hook, a skill, and an MCP entry — into the
harness config it finds. It is idempotent: run it again after an upgrade and it
refreshes what it wrote and leaves what it did not.

What `init` actually installs, and why each piece exists:

```mermaid
flowchart TD
    subgraph Repo[your repository]
        H[".claude/settings.json<br/><i>hooks</i>"]
        S[".claude/skills/parley/SKILL.md<br/><i>how an agent should use it</i>"]
        M["MCP entry<br/><i>tools, for harnesses that prefer them</i>"]
    end
    subgraph Machine[the machine]
        D["parley daemon<br/><i>starts itself on first use</i>"]
        J["journal<br/><i>every frame, before it is applied</i>"]
    end
    H -->|"every tool call"| D
    M -->|"tool calls"| D
    D --> J
    S -.->|"read by the agent,<br/>not executed"| H
```

The daemon is not something you start. The first command that needs it spawns
it, and it shuts itself down when the last session leaves.

Check it landed:

```bash
parley doctor
```

## What runs by itself, and what you launch

| | who starts it | when it stops |
|---|---|---|
| **daemon** | the first command that needs one | when the last front leaves, or after 30 min idle |
| **hook** | your harness, on every tool call | with the tool call — it is a short-lived process |
| **panel** | you, with `parley watch` | when you close it |

You never start the daemon by hand. If you want to watch what is happening, that
is the panel — see [The panel](/guide/panel).

## Choosing a mode

`mode` decides what happens when two sessions want the same file.

```mermaid
flowchart LR
    O["<b>off</b><br/>parley records,<br/>refuses nothing"] --> A
    A["<b>advisory</b><br/>you are told who holds it,<br/>you decide<br/><i>the default</i>"] --> E
    E["<b>enforced</b><br/>a colliding edit is refused<br/>until it is granted"]
```

Start on `advisory`. It is the default because it is the one that cannot cost
you an edit you meant to make, and it still turns silent collisions into visible
ones — which is the whole point.

`enforced` is for when you have several agents running unattended and would
rather a refusal than a conflict.

```bash
parley mode enforced
```

This is a property of the repository, not of your session: everyone on the bus
gets it.

## Next

- **If you are an agent**, read [You are an agent on this bus](/guide/for-agents).
  It is the page written for you.
- **If you are the person**, [The panel](/guide/panel) is how you watch without
  interrupting anyone.
- Working across several repositories at once?
  [Workspaces](/guide/workspaces).
