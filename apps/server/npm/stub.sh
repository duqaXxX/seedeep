# Ships as `bin/seedeep.exe` inside the `seedeep` package, and is what `bin` points at. The
# postinstall replaces this file with the platform's native executable, so this text only ever runs
# when the postinstall did NOT.
#
# bun is the case that matters, and it is not an edge one — seedeep is built with bun, so its own
# audience installs that way: `bun install -g seedeep` BLOCKS the postinstall by default and says
# "Blocked 1 postinstall" (measured 2026-08-03 on bun 1.3.13). The install looks like it worked, and
# the command is this file. `--trust` at install time avoids this text entirely; `bun pm trust`
# finishes an install that already happened, which is the situation whoever reads this is in.
#
# npm is moving the same way and is named for when it arrives: 11.17 still RUNS the script and only
# warns that this package's scripts are unreviewed, offering `--allow-scripts=seedeep` (measured on
# a real install from the registry). A package manager that stops running install scripts by default
# is the one thing that turns this whole channel into a placeholder, so the gesture is written down
# before it is needed rather than after.
#
# It carries NO SHEBANG on purpose, and that is not a style choice: on Windows npm generates the
# `.cmd` shim from this file BEFORE the postinstall runs, and cmd-shim only emits a direct exec of
# the target when it finds no shebang to honour (verified in npm 10.9's `cmd-shim/lib/index.js`:
# with no shebang match it sets `prog = "%dp0%\<target>"` and clears the interpreter). A `#!` line
# here would make every Windows install run `sh seedeep.exe` — including after the real binary has
# replaced this file.
echo "seedeep: the native binary was not installed." >&2
echo "" >&2
echo "Its postinstall never ran, so this file is still a placeholder." >&2
echo "" >&2
echo "If you installed with bun, it blocked the script and this finishes the job:" >&2
echo "  bun pm -g trust seedeep      # drop -g for a local install" >&2
echo "" >&2
echo "Installing with 'bun install -g seedeep --trust' does it in one step." >&2
echo "" >&2
echo "If npm asked you to review this package's scripts, allow them:" >&2
echo "  npm install -g --allow-scripts=seedeep" >&2
echo "" >&2
echo "If you passed --ignore-scripts, or your package manager blocks install" >&2
echo "scripts, run it by hand from the package's own directory:" >&2
echo "  node install.cjs" >&2
echo "" >&2
echo "If the platform package was skipped (--omit=optional), reinstall without it." >&2
exit 1
