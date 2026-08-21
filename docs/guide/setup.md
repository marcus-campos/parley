# Set up a repository

This page is a walkthrough: what to type, in what order, and how to tell it
worked. For what each hook actually does, see the
[`Set it up in a repository`](https://github.com/marcus-campos/parley#set-it-up-in-a-repository)
section of the README; this page does not repeat that table.

## The first five minutes

1. **Install the binary** once, machine-wide. See [Install](/guide/install)
   if you have not yet.
2. **Register the hooks, once per machine:**

   ```bash
   parley init --global
   ```

   This is the step people skip and then wonder why a second worktree is
   silent. Do it once and forget about it — it is inert everywhere parley has
   not been asked to run.
3. **Turn on the repository you are actually working in:**

   ```bash
   cd path/to/your-repo
   parley init
   ```

   You will be shown a diff of the exact lines it wants to add to
   `.claude/settings.json` before anything is written. Read it, then confirm.
4. **Start a session and check it joined:**

   ```bash
   parley who
   ```

   You should see one entry with a name derived from your branch or worktree.
   If the list is empty, the hooks did not fire — jump to Troubleshooting
   below before doing anything else.
5. **Say something, from a second session if you have one open:**

   ```bash
   parley say "hello from setup"
   ```

   If a second terminal's agent reports receiving it on its next turn, the
   whole loop — join, hook, journal, drain — is working end to end.

That is the entire setup. Everything after this point (territory on first
edit, presence, the inbox draining into context) runs by itself; you do not
run further commands to keep it going.

## One repository, many worktrees

`parley init --global` is what makes this work: the hooks live outside the
working tree, so every worktree of the repository picks them up without a
second `init`. If you only ever run `parley init` (without `--global`) in
your main checkout, a session opened in a worktree will look installed —
`.claude/skills/parley` exists there too, since skills are usually tracked —
but the hooks that actually join the bus and settle territory will be
missing, because `.claude/settings.json` is untracked and worktree-local.
Running the global command once resolves this for every worktree you create
afterward, including ones that do not exist yet.

## Multiple repositories under one VS Code workspace

If you drive several repositories from a single `.code-workspace` file, a
plain `parley init` per folder gives each one its own bus, and two sessions
working across the same set of projects will not see each other. That case
has its own command (`parley init --workspace`) and its own section in the
README — see
[VS Code multi-root workspaces](https://github.com/marcus-campos/parley#vs-code-multi-root-workspaces).
Skip this section entirely if you only ever open one repository at a time.

## Verifying it actually worked

`parley doctor` is the single command worth memorizing for this. It reports,
for the repository you are standing in:

- which identity parley resolved (repository or workspace, and which one)
- which transport it will use (unix socket, named pipe, or loopback — this
  matters most in WSL)
- whether the skill in this project matches the binary you have installed
- the mode and shape currently in effect

Run it any time something feels off before reaching for anything more
invasive. It is read-only and safe to run as often as you like.

## Troubleshooting

**`parley who` shows nobody, including you.** The most common cause is a
missing global hook install — `parley init --global` — combined with a
worktree or a fresh clone that never had `parley init` run inside it either.
Run both, in that order, and start a new session; hooks only take effect for
sessions that start after they are installed, not the one already running.

**A second worktree behaves like parley was never set up, even though your
main checkout works fine.** This is almost always the missing `--global`
step described above — `.claude/settings.json` is per-worktree, so a purely
local `init` never reaches siblings.

**`parley init` refuses to write anything, or asks for permission you did
not expect.** It never edits configuration silently. If it is showing you a
diff you did not anticipate, read it before confirming — usually it means
another tool already owns a hook slot it wants to extend.

**You want to remove parley from a repository entirely.** `parley uninit
[--global]` removes exactly what the matching `init` wrote, and nothing it
did not.

## Undoing a mistake

Nothing here is one-way. If a repository was set up in error, `parley
uninit` reverses it; if a hook is misbehaving, `parley mode off` disables
territory and permission enforcement without removing the hooks themselves,
which is the fastest way to rule out "is this parley" while you investigate.
