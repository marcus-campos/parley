# The panel

The README already documents what each panel shows and every key you can
press — see
[Following along: the panel](https://github.com/marcus-campos/parley#following-along-the-panel)
if you have not read it. This page is about *using* it day to day: which one
to reach for, how to run it alongside your actual work, and what to do when
it will not start.

## Terminal or web — pick by what else is on your screen

Reach for the **terminal panel** (`parley watch`) when you already live in a
multiplexer — tmux, a split iTerm pane, a second `screen` window. It costs
nothing to start, needs no port, and leaving it is `Ctrl+C` back to your
shell. If you are the kind of person who already keeps a pane open for `git
status`, this is that pane's neighbor.

Reach for the **web panel** (`parley watch --web`) when you want it open
continuously without owning a terminal tab, or when you want to glance at it
from a browser window on a second monitor. `--detach` is the option that
makes this practical: start it once, close the terminal, and the URL keeps
working until you `--stop` it.

Running both at once is fine. They read the same bus and neither one holds a
lock on it.

## A workflow that actually uses it

Open a second pane before you open your first agent session, not after —
that way you see the join happen instead of taking it on faith:

```bash
# pane 1
parley watch

# pane 2
claude          # or codex, or whatever you drive sessions with
```

Leave pane 1 alone. The panel is built to be glanced at, not typed into —
the composer only appears when you press <kbd>i</kbd> (or <kbd>s</kbd> on
the web page), and closes itself again. If you are watching a long-running
task, the moment you actually need the panel is when a **pending permission**
line shows up with a countdown: that is the signal that one front is waiting
on another, and it is the one thing worth interrupting your own work for,
since an unanswered request resolves itself on a timer whether or not anyone
looked at it.

For a detached web panel you plan to leave running across many sessions,
treat the printed URL like a bookmark — it includes the access token, so
save the whole thing, not just the host and port.

## Watching from somewhere the panel is not

The web panel binds to `127.0.0.1` only, on purpose — it is not meant to be
reachable from the network. If you are working on a remote box over SSH and
want the panel on your local browser anyway, forward the port instead of
changing the bind address:

Start the panel on the remote box first and **read the port off the URL it
prints** — do not guess it. `7717` is the base of a range, not the port: the
panel listens on `7717 + (hash of the repository id % 200)`, so any port from
`7717` to `7916` is normal and this repository, for instance, derives `7780`
(`src/cli/web.ts:79-85`). Forward the port you actually saw:

```bash
# on the remote box
parley watch --web --detach --no-open
# parley: web panel on http://127.0.0.1:7780/?t=<token>

# on your local machine — 7780 here because that is what it printed
ssh -L 7780:127.0.0.1:7780 you@remote-box
```

Then open the printed URL unchanged in your local browser, token and all,
with the same port on both sides of the `-L`.

The derived port is stable across restarts **as long as it is free**. If
something else already holds it, parley does not fail and does not fight for
it: it hands the choice to the operating system and takes whatever it is
given (`chosen = 0`, `src/cli/web.ts:184-188`), which is a different,
unpredictable port. So a forwarding rule set up once usually keeps working —
but it is the printed URL, not the rule, that is authoritative. Check it
whenever the panel does not answer.

## When it does not come up

**"Address already in use" or it silently picks a different port than you
expected.** Another panel for this repository is probably already running —
try `parley watch --web --detach` again first; a second `--detach` attaches
to the existing one instead of fighting it for the port. If you specifically
need a fixed port, `--port N` will tell you plainly that it is taken rather
than binding somewhere else quietly.

**The browser tab loads but shows nothing, or the token in the URL looks
wrong.** The token is generated per launch; a bookmarked URL from a previous
`--detach` run will not match a new one. Re-copy the URL parley prints the
next time you start it, rather than reusing an old bookmark, unless you
attached to an already-running panel as above.

**The terminal panel renders with boxes or question marks instead of
borders.** That is the ASCII fallback for a terminal that did not advertise
UTF-8 support — harmless, and a sign to check your terminal's locale
settings if you would rather have the real borders back.

**Nothing shows up in either panel at all.** That is very likely a setup
problem, not a panel problem — see [Set up a repository](/guide/setup) and
confirm `parley who` sees anyone before troubleshooting the panel itself.
