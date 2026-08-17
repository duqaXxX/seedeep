# seedeep

### *See deep into what Claude Code is doing.*

`seedeep` makes visible what a Claude Code session hides: **how the context window
fills, live, during a turn** — and what the subagents are doing while it happens.
It reads the session logs Claude Code already writes on your machine. No session
content is sent anywhere and nothing is written back — the only outbound request it
makes on its own is the update check against npm, which `seedeep update --offline`
skips.

![The context window filling live while six subagents run on three models](https://raw.githubusercontent.com/duqaXxX/seedeep/v{{VERSION}}/docs/assets/hero.gif)

*3% → 26% of the window, six subagents on three different models, 2.9M tokens
billed — 2.5M of them the same context read again.*

```sh
npm i -g seedeep                       # or: bun install -g seedeep --trust
seedeep
```

It serves a local page and opens it. One process, no daemon, stopped with Ctrl-C.

`--trust` is not optional under Bun: it blocks a dependency's install script by default, and that
script is what puts the binary in place. Without it `seedeep` prints the one command that finishes
the job. npm runs it either way.

```sh
seedeep --port 9000   # a different port (default 44842)
seedeep --no-open     # do not open the browser
```

**Node is needed to install this, never to run it.** The package carries a compiled
executable with its own runtime inside — `npm` places it on your PATH and steps
out of the way.

Full documentation, the optional menu-bar tray, and the plain downloads for a
machine without Node: **https://github.com/duqaXxX/seedeep**
