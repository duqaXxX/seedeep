# seedeep

### *See deep into your agent's context.*

`seedeep` makes visible what a Claude Code session hides: **how the context window
fills, live, during a turn** — and what the subagents are doing while it happens.
It reads the session logs Claude Code already writes on your machine. Nothing is
sent anywhere, nothing is written back.

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
