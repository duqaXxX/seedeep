//! The seedeep server on THIS machine: finding it, starting it, stopping it.
//!
//! The tray is a pure HTTP client of a server it does not own — except in the one case this module
//! is about, where the two are co-located and a user with no terminal has no other way to get a
//! server at all. Everything here is therefore gated on being local: none of it is offered when the
//! tray is pointed at another host, where the process is somebody else's to manage.
//!
//! Four facts shape it, and each was measured rather than assumed (2026-08-04):
//!
//! * **A macOS GUI app's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`.** Measured on a Finder launch —
//!   `open` from a terminal passes its own environment down, so that route cannot see this and says
//!   the opposite. Neither `seedeep` nor `npm` is on it, whichever channel installed them, so the
//!   tray has to ASK a shell where the executable is instead of exec'ing a bare name.
//! * **A login shell is not enough.** `zsh -lc` reads `.zprofile` (where Homebrew's installer
//!   writes) and NOT `.zshrc` (where bun's and nvm's do): on the machine this was measured on it
//!   missed `~/.bun/bin` entirely, which is one of the three channels seedeep ships through.
//!   `-l -i -c` sees both, and cost 0.02 s.
//! * **The file on PATH may not be the server.** npm's postinstall replaces a placeholder that
//!   prints instructions and exits 1, and a `bun install -g` without `--trust` leaves that
//!   placeholder in place. So a start is proven by the server ANNOUNCING itself, never by a file
//!   existing — and never by inspecting that file, which is a guess about a shape npm owns.
//! * **That placeholder cannot be exec'd directly.** It carries no shebang (deliberately — see
//!   `apps/server/npm/stub.sh`), so `execve` on it fails with `ENOEXEC` and the user would be told
//!   "Exec format error" instead of the four lines the file exists to print. Going through
//!   `sh -c 'exec "$0"'` takes the shell's ENOEXEC fallback and produces the real message; for a
//!   native binary the `exec` means the pid is the server's, with no shell left in between.
//!
//! Nothing here writes to the server's own state. The one file it creates is the log a spawned
//! server's output goes to, because a process started from a menu bar has no terminal to print
//! its TLS fingerprint — or its refusal to start — into.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::net::{TcpListener, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use tokio::time::sleep;

use crate::client::Status;

/// How long the user's shell gets to say where seedeep is. A `.zshrc` that starts a version manager
/// is slow, not broken; a shell that never answers is what this is for.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a look that found nothing stands before another is worth doing. The poll asks on every
/// reading and the answer changes only when the user installs seedeep, so this is the difference
/// between a shell per 30 s and a shell per second.
const LOOKUP_RETRY: Duration = Duration::from_secs(30);

/// How long a start gets to announce itself before it is called a failure. Generous on purpose: the
/// record is written straight after the bind, but a cold executable on a slow disk is a real start
/// that has not failed.
const START_TIMEOUT: Duration = Duration::from_secs(15);

/// How long a stop gets to withdraw its record. The withdrawal is synchronous in the server, so
/// this only has to cover the signal being delivered and the process getting to its handler.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// How often the records are re-read while waiting for either.
const STEP: Duration = Duration::from_millis(150);

/// Whether this build is a checkout, decided at compile time.
///
/// `tauri::is_dev()` is `!cfg!(feature = "custom-protocol")`, and `tauri build` is what turns that
/// feature on — so this is a fact about how the binary was produced, not a variable anyone can set
/// for their own reasons. `SEEDEEP_HOME` would have been the wrong test: a user is entitled to move
/// their state without their tray calling itself a development build.
pub const DEV_BUILD: bool = tauri::is_dev();

/// Why the panel can or cannot offer to start a server here — three states, because the two that
/// are not `Ready` need DIFFERENT WORDS and a boolean cannot carry that.
///
/// A single `can_start: bool` shipped first and produced a dead end the moment a user pressed Stop:
/// with nothing installed the screen fell through to "open the portal on the machine running
/// seedeep and copy the URL", which is advice for a server somewhere else, given to somebody who
/// had just switched off the one in front of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Start {
    /// Nothing is answering here and there is an executable to run: draw the button.
    Ready,
    /// Nothing is answering here and nothing was found to run. `dev` because the two cases need
    /// different instructions — a checkout's server is `bun run dev`, which is not something the
    /// tray can exec, and telling that user to `npm i -g seedeep` would be sending them away from
    /// the very thing they are working on.
    NotInstalled { dev: bool },
    /// Not about this machine at all: something is already answering, or the tray is pointed
    /// elsewhere. The existing screens are right for this and say nothing about starting.
    Elsewhere,
}

/// What the panel may offer for a server on this machine — the whole of what the tray decides here,
/// so the rules live in one place rather than in the two surfaces that draw them.
///
/// `can_stop` is false whenever the tray is not connected to a server it can name a single process
/// for, which includes every server on another host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Local {
    pub start: Start,
    pub can_stop: bool,
}

impl Default for Local {
    fn default() -> Self {
        Self {
            start: Start::Elsewhere,
            can_stop: false,
        }
    }
}

/// A server that is up, as it announces itself in `<seedeep home>/servers/<pid>.json` — the shape
/// `apps/server/src/server/run-state.ts` writes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningServer {
    pub pid: u32,
    /// Scheme, host and port. Never a token: the record is read to identify a process, not to
    /// authorise against it.
    pub base_url: String,
}

/// How to talk to the server on THIS machine, taken from the file it keeps them in.
///
/// Both are `Option` because a loopback server has neither: no token to demand and no certificate
/// to present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalCredentials {
    pub token: Option<String>,
    pub fingerprint: Option<String>,
}

/// The shape of `<seedeep home>/config.json` that the tray reads — two fields of many, named so a
/// change to the rest cannot break this.
#[derive(Deserialize)]
struct ServerConfig {
    auth: Option<AuthSection>,
    tls: Option<TlsSection>,
}

#[derive(Deserialize)]
struct AuthSection {
    token: Option<String>,
}

#[derive(Deserialize)]
struct TlsSection {
    cert: Option<String>,
}

/// The SHA-256 of the first certificate in a PEM, in the colon-separated form the panel and the
/// server both print.
///
/// Hand-decoded rather than through a PEM crate: the whole of it is one base64 body between two
/// markers, and `base64` is already in the locked graph.
fn fingerprint_of_pem(pem: &str) -> Option<String> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let body = pem.split_once(BEGIN)?.1.split_once(END)?.0;
    let der = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        body.split_whitespace().collect::<String>(),
    )
    .ok()?;
    Some(crate::pin::fingerprint(&der))
}

/// Where seedeep keeps its state, from the environment the tray was launched with.
///
/// `SEEDEEP_HOME` is honoured for the same reason the server honours it — a dev run points both at
/// a directory inside the checkout — but a GUI app inherits no shell environment, so in practice
/// this is `~/.seedeep`. A user who sets `SEEDEEP_HOME` in their shell profile therefore gets a
/// server whose records the tray cannot see; that is a stated limit, not a silent one (`docs/tray.md`).
pub fn seedeep_home(home: PathBuf, override_var: Option<OsString>) -> PathBuf {
    match override_var.map(PathBuf::from).filter(|p| !p.as_os_str().is_empty()) {
        Some(dir) => std::path::absolute(&dir).unwrap_or(dir),
        None => home.join(".seedeep"),
    }
}

/// The three spellings of this machine. They are ONE host, and treating them as three is what made
/// the default case fail — see {@link same_server}.
fn is_loopback_host(host: &str) -> bool {
    host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
}

/// Whether a URL is SPELLED as this machine — the cheap half of {@link LocalServer::here}.
///
/// Never a reachability test: a server on another machine may well answer faster than a local one,
/// and "I can talk to it" has never meant "I can signal it".
fn is_local(base_url: &str) -> bool {
    Url::parse(base_url).ok().and_then(|u| u.host_str().map(is_loopback_host)) == Some(true)
}

/// Whether `host` NAMES this machine — asked of the resolver, and answered by identity rather than
/// by reachability.
///
/// The spelling test above is not enough, and that was a real dead end: a server with remote access
/// on announces the name it was configured with, and macOS resolves a machine's own `<name>.local`
/// to `::1` and `127.0.0.1` alongside its LAN address (measured). So Start never appeared for a
/// server sitting right there, on the grounds that `dev-mac.local` is not spelled `127.0.0.1`.
///
/// Loopback is conclusive on its own: `127.0.0.1` means "me" to whoever resolved it. For every other
/// answer the question is whether this machine HOLDS that address, and a bind is the exact test —
/// the kernel refuses `EADDRNOTAVAIL` for an address that is not on one of its interfaces. Port 0,
/// so it takes an ephemeral one and gives it straight back; no crate is needed to enumerate
/// interfaces, and nothing is asked of the network.
fn names_this_machine(host: &str) -> bool {
    // Rejected before the resolver, because the resolvers disagree about it: on Windows the empty
    // host RESOLVES — to this machine — while macOS calls it an error, so without this the same
    // malformed record is co-located on one platform and foreign on the other. Nothing is not a
    // host anywhere, and the test said so before either resolver was asked.
    if host.is_empty() {
        return false;
    }
    let Ok(addrs) = (host, 0u16).to_socket_addrs() else { return false };
    addrs.into_iter().any(|a| a.ip().is_loopback() || TcpListener::bind((a.ip(), 0)).is_ok())
}

/// Whether a URL is one this tray may adopt on sight: plaintext, so there is no identity to
/// confirm. An `https://` record would be trusted with no fingerprint — learning mode in `pin.rs`,
/// which is exactly the confirmation {@link Conn::connect} refuses to skip.
pub fn is_plaintext(base_url: &str) -> bool {
    Url::parse(base_url).ok().map(|u| u.scheme() == "http") == Some(true)
}

/// The port an address answers on, for the two rules that have to order or reproduce one.
pub fn port_of(base_url: &str) -> Option<u16> {
    Url::parse(base_url).ok().and_then(|u| u.port_or_known_default())
}

/// Scheme, host and port, with every spelling of loopback collapsed to one — what a comparison
/// between two addresses has to be made on.
fn origin_key(base_url: &str) -> Option<(String, String, u16)> {
    let url = Url::parse(base_url).ok()?;
    let host = url.host_str()?;
    let host = if is_loopback_host(host) { "localhost" } else { host };
    Some((url.scheme().to_owned(), host.to_owned(), url.port_or_known_default()?))
}

/// Whether two addresses name the same server.
///
/// NOT string equality, and that is a defect this shipped with: the server in loopback mode
/// announces `http://localhost:<port>` (`server.ts`, `displayHost`), while the tray's
/// zero-configuration connection is `http://127.0.0.1:44842` — so the exact-match rule found no
/// record for the very server Start had just launched, and Stop never appeared. The two are one
/// address; the code was reading two.
///
/// Safe because the port cannot be bound twice on one host. The one case that could still produce
/// two records claiming this — a server on `127.0.0.1` and another on `::1`, same port — is the
/// ambiguity {@link LocalServer::stoppable} refuses rather than resolves.
fn same_server(a: &str, b: &str) -> bool {
    match (origin_key(a), origin_key(b)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// True while a process with `pid` exists.
///
/// `EPERM` counts as alive, exactly as the server's own `isAlive` treats it: the call was refused,
/// which is only possible for a process that is there. A record whose process is gone describes
/// nothing, and after a crash it may describe a pid the OS has since given to something else.
#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // NOT a process, either of them, and the reason this exists rather than being obvious: `kill`
    // reads a NON-POSITIVE argument as a process GROUP. 0 is the caller's own group — the same pid
    // handed to the stop would send SIGTERM to the tray itself — and anything above `i32::MAX` wraps
    // negative on the cast below, where `-1` means every process this user may signal. Both come
    // from a filename, so both are one malformed file away, and this is where malformed has to stop
    // being dangerous.
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: `kill` with signal 0 performs the permission checks and sends nothing.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// The same question on Windows, where there are no signals: a handle that opens for a process
/// whose exit code is still `STILL_ACTIVE`.
///
/// `PROCESS_QUERY_LIMITED_INFORMATION` rather than `PROCESS_QUERY_INFORMATION`: it is the right
/// asked for here (an exit code) and the one granted across integrity levels.
#[cfg(windows)]
fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: the handle is closed on every path, and `code` is only read when the call succeeded.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
}

/// Whether `cmd /C` can execute this path — the Windows half of "is this an answer".
///
/// `npm i -g` installs THREE shims: `seedeep` (a POSIX sh script), `seedeep.cmd` and `seedeep.ps1`.
/// `where.exe seedeep` lists the extensionless one FIRST, and handing that to `cmd` fails — so
/// "the first existing file" is the wrong rule on Windows, where only an extension makes a file
/// executable. Deliberately not PATHEXT read from the environment: what runs the file is `cmd /C`,
/// so what matters is what cmd itself can start, and a `.ps1` in PATHEXT is not that.
///
/// Defined on every platform because the RULE deserves a test even where it does not run.
#[cfg_attr(not(windows), allow(dead_code))]
fn cmd_can_run(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "exe" | "cmd" | "bat" | "com"))
}

/// Windows creation flag that keeps a console application from being given a console.
///
/// Every process this module starts on Windows needs it. A GUI application has no console, so
/// Windows allocates one for any console child it spawns — and the user sees it flash. Two of the
/// three here were missing it, which is what a flash on tray startup and on stop was.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The first line of `stdout` that names an executable file, or nothing.
///
/// A line at a time, and the whole line has to be an existing absolute path: an interactive shell
/// is entitled to print onto stdout (a motd, a version manager's banner), and `command -v` for a
/// shell FUNCTION prints its body rather than a path. Anything that is not a file on disk is not
/// an answer to where seedeep is.
///
/// On unix an extension means nothing and a file is enough — the spawn goes through `sh`, which
/// runs a text file with no shebang at all. On Windows it is the opposite; see {@link cmd_can_run}.
fn first_executable(stdout: &str) -> Option<PathBuf> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| {
            #[cfg(windows)]
            if !cmd_can_run(path) {
                return false;
            }
            path.is_absolute() && path.is_file()
        })
}

/// Ask the user's own shell where `seedeep` is, as a login AND interactive shell.
///
/// Both flags, and passed separately rather than as `-lic`: `-l` alone misses every PATH written by
/// an installer into `.zshrc` (bun's, nvm's), and a combined cluster is not something every shell
/// on `$SHELL` parses. stdin is closed so an interactive shell cannot sit waiting on it.
#[cfg(unix)]
async fn ask_where_seedeep_is() -> Option<PathBuf> {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let output = tokio::time::timeout(
        LOOKUP_TIMEOUT,
        Command::new(shell)
            .args(["-l", "-i", "-c", "command -v seedeep"])
            .stdin(Stdio::null())
            // Discarded, not inherited: an interactive shell warns about job control on a pipe, and
            // that noise is not an answer.
            .stderr(Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    first_executable(&String::from_utf8_lossy(&output.stdout))
}

/// The same question on Windows, where there is nothing to escape: a GUI process inherits the
/// machine's and the user's PATH from the registry, so `where.exe` answers with what a new console
/// would run.
#[cfg(windows)]
async fn ask_where_seedeep_is() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    let output = tokio::time::timeout(
        LOOKUP_TIMEOUT,
        Command::new("where.exe")
            .arg("seedeep")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            // A console application started by a windowless one is given a console of its own, and
            // the user sees it flash. This lookup runs while the tray is starting, which is exactly
            // when a flash was reported (Windows 11, 2026-08-15).
            .creation_flags(CREATE_NO_WINDOW)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    first_executable(&String::from_utf8_lossy(&output.stdout))
}

/// Start `exe` as a server that outlives this process, with its output going to `log`.
///
/// Through `sh -c 'exec "$0" "$@"'` and not directly, for the ENOEXEC reason in this module's
/// header: the npm placeholder has no shebang, and only a shell turns that into the message it was
/// written to print. `"$0"` carries the path as an argument rather than inside the script, and
/// `"$@"` the flags, so a path with spaces needs no quoting rules of ours. `exec` leaves no shell in
/// between, so the pid is the server's.
///
/// `setsid` puts it in a session of its own: a terminal that signals the tray's process group — a
/// `bun run tray:dev` under Ctrl-C — must not take the server with it, because the decision on this
/// card is that the server survives the tray.
#[cfg(unix)]
fn spawn_detached(exe: &Path, args: &[String], log: fs::File) -> std::io::Result<Child> {
    let err = log.try_clone()?;
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(r#"exec "$0" "$@""#)
        .arg(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err));
    // SAFETY: `setsid` is async-signal-safe, which is the whole requirement between fork and exec.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    command.spawn()
}

/// The same on Windows, where what is on PATH is npm's `.cmd` shim and only `cmd` can run it.
///
/// `CREATE_NO_WINDOW` because the alternative is a console window appearing over whatever the user
/// was doing and staying there for the life of the server.
///
// LIMIT: unverified — this branch has never run on a Windows machine, only compiled for one.
#[cfg(windows)]
fn spawn_detached(exe: &Path, args: &[String], log: fs::File) -> std::io::Result<Child> {
    use std::os::windows::process::CommandExt;
    let err = log.try_clone()?;
    Command::new("cmd")
        .arg("/C")
        .arg(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
}

/// Open the log a spawned server writes to, readable only by this user.
///
/// The mode is not tidiness. The server's first line is the URL it serves, and in remote mode that
/// URL carries the TOKEN — measured on a real start, which is how this was found: the same secret
/// the server keeps at 0600 in `~/.seedeep/config.json` was landing in a 0644 file beside it. A
/// world-readable copy of a credential is a credential the machine's other users have.
///
/// Both the flag and the explicit `set_permissions`: `mode()` applies only when the file is
/// CREATED, so a log already on disk from an earlier version would keep whatever it was made with.
fn create_log(path: &Path) -> std::io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// Ask a process to stop the way a terminal would.
///
/// SIGTERM, not SIGKILL: the server's handler stops the watcher, stops the listener and withdraws
/// its record synchronously. A killed server leaves that record behind for a recycled pid to
/// inherit, which is the one thing the record's design set out to prevent.
#[cfg(unix)]
async fn ask_to_stop(pid: u32) -> Result<(), String> {
    // Unreachable — only a pid `alive()` has already vetted gets here — and stated anyway, because
    // what is on the other side of it is `kill(-1, SIGTERM)`: every process this user can signal.
    // A guard whose failure is that large is not one to leave to a caller's discipline.
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(format!("{pid} is not a process id."));
    }
    // SAFETY: a signal to a pid; the failure is reported through errno like any other call.
    if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } == 0 {
        return Ok(());
    }
    Err(format!("seedeep could not be signalled: {}", std::io::Error::last_os_error()))
}

/// The same on Windows, which has no signal to send.
///
/// `taskkill /F` is a hard stop: the server never reaches its shutdown path, so its record is left
/// behind and cleared by the sweep the next start performs. That is worse than a SIGTERM and it is
/// what the platform offers — `taskkill` without `/F` posts `WM_CLOSE`, which a process with no
/// window never receives.
///
// LIMIT: unverified — this branch has never run on a Windows machine, only compiled for one.
#[cfg(windows)]
async fn ask_to_stop(pid: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        // Same reason as the lookup above: without it, stopping the server flashes a console.
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .await
        .map_err(|e| format!("seedeep could not be stopped: {e}"))?;
    if status.success() {
        return Ok(());
    }
    Err("seedeep could not be stopped: taskkill refused.".into())
}

/// The cached answer to "where is seedeep", and when it was last looked for.
#[derive(Default)]
struct Lookup {
    /// A path that was found. Kept for the life of the process: an executable does not move, and a
    /// user who removes it gets the spawn's own error, which says more than a missing button.
    path: Option<PathBuf>,
    /// When the last look happened, so a miss is retried without a shell on every tick.
    looked: Option<Instant>,
    /// Bumped by {@link LocalServer::forget}, and carried by every look in flight, so an answer
    /// that was already stale when it arrived cannot be written down.
    ///
    /// Without it the retry is worse than useless. The first shell is cold and takes three seconds;
    /// a second into it the user installs seedeep and presses *Look again*, whose own shell is warm
    /// and comes back with the path. The first one then lands with its `None`, overwrites the path
    /// AND re-stamps `looked` — so the button disappears and the throttle refuses to look again for
    /// thirty seconds.
    generation: u64,
}

impl Lookup {
    /// What the POLL may answer without running a shell: a path, or a "no" too recent to be worth
    /// re-asking. `None` means it is time to look.
    ///
    /// The throttle is here and nowhere else, because the poll is the only caller that repeats on a
    /// clock — see {@link Lookup::for_a_click}.
    fn for_the_poll(&self) -> Option<Option<PathBuf>> {
        if self.path.is_some() {
            return Some(self.path.clone());
        }
        self.looked.filter(|at| at.elapsed() < LOOKUP_RETRY).map(|_| None)
    }

    /// What a CLICK may answer without running a shell: only a path that was found.
    ///
    /// A remembered "no" is deliberately NOT enough. The throttle exists so the poll does not spawn
    /// a login shell every five seconds; a person pressing *Look again* is not the poll, and they
    /// pressed it precisely because that remembered "no" is what they have just changed. Answering
    /// them from it made the button unable to report anything but failure.
    fn for_a_click(&self) -> Option<PathBuf> {
        self.path.clone()
    }
}

/// The local server: where its state lives, and what the tray has learned about starting it.
pub struct LocalServer {
    home: PathBuf,
    found: Mutex<Lookup>,
    /// What each host name was last found to be, and when — see {@link LocalServer::here}.
    ///
    /// `None` means a look is in flight. Resolution CANNOT happen on the poll's thread: a `.local`
    /// name that no longer exists takes 5.0 s to fail (measured against 4.5 ms for one that does),
    /// and the poll is what paints the menu-bar icon. That is the same five seconds the executable
    /// lookup was moved off this loop for.
    resolved: Mutex<HashMap<String, (Option<bool>, Instant)>>,
}

impl LocalServer {
    /// A local-server layer over `home`, the directory seedeep keeps its state in.
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            found: Mutex::new(Lookup::default()),
            resolved: Mutex::new(HashMap::new()),
        }
    }

    /// Where a server started from the tray writes what it says.
    ///
    /// One file, truncated by each start: it exists so a start that failed can be explained and so
    /// the TLS fingerprint a pinned client needs is not lost with the terminal the server does not
    /// have. Keeping a history would make it a log to rotate, which is a thing to maintain rather
    /// than a thing to read.
    pub fn log_path(&self) -> PathBuf {
        self.home.join("server.log")
    }

    /// Every server running on this machine right now, dead and malformed records excluded.
    ///
    /// The pid in the NAME is the one proven alive, and a file claiming a different one is either
    /// hand-edited or left by a recycled pid — the same rule the server's own reader applies, for
    /// the same reason: this is what a stop is aimed at.
    pub fn running(&self) -> Vec<RunningServer> {
        let dir = self.home.join("servers");
        let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(stem) = Path::new(&name).file_stem().and_then(|s| s.to_str()) else { continue };
            let Ok(pid) = stem.parse::<u32>() else { continue };
            if !alive(pid) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(entry.path()) else { continue };
            let Ok(record) = serde_json::from_str::<RunningServer>(&raw) else { continue };
            if record.pid == pid && !record.base_url.is_empty() {
                out.push(record);
            }
        }
        out
    }

    /// Where seedeep is on this machine, for a GESTURE. WAITS for the shell — only a click may do
    /// that.
    ///
    /// A known path is reused, but a remembered "no" is NOT: the throttle exists so the poll does
    /// not run a shell every tick, and a user who just pressed a button is not the poll. Answering
    /// them from a thirty-second-old miss is answering the question they pressed the button to
    /// re-ask — which is what made *Look again* unable to report anything but failure.
    ///
    /// The lock is never held across the await: the poll and a click can both be here, and the cost
    /// of two shells is a duplicated 0.02 s, while the cost of holding a lock across an await is a
    /// tray that stops answering.
    pub async fn executable(&self) -> Option<PathBuf> {
        let generation = {
            let cache = self.found.lock().unwrap();
            if let Some(known) = cache.for_a_click() {
                return Some(known);
            }
            cache.generation
        };
        let found = ask_where_seedeep_is().await;
        self.remember(found.clone(), generation);
        found
    }

    /// What is known NOW, starting a look in the background when it is time for one.
    ///
    /// The poll reads this, and never {@link LocalServer::executable}: that one waits on a shell for
    /// up to five seconds, and the poll's loop is what paints the menu-bar icon and sends the
    /// notifications. A user with a version manager in their `.zshrc` — the very reason the lookup
    /// is an interactive shell — would have had the icon freeze for five seconds every thirty.
    ///
    /// The cost is that a newly installed seedeep appears one tick late. It is paid where nobody is
    /// looking: the first look happens on the tray's first reading, long before anyone opens the
    /// panel.
    fn look_soon(self: &Arc<Self>) -> Option<PathBuf> {
        if let Some(known) = self.found.lock().unwrap().for_the_poll() {
            return known;
        }
        // Stamped BEFORE the look, so a second tick a second later does not start a second shell.
        let generation = {
            let mut cache = self.found.lock().unwrap();
            cache.looked = Some(Instant::now());
            cache.generation
        };
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let found = ask_where_seedeep_is().await;
            me.remember(found, generation);
        });
        None
    }

    /// Write down what a look found, unless a {@link LocalServer::forget} happened while it ran —
    /// see {@link Lookup::generation}.
    fn remember(&self, found: Option<PathBuf>, generation: u64) {
        let mut cache = self.found.lock().unwrap();
        if cache.generation != generation {
            return;
        }
        cache.path = found;
        cache.looked = Some(Instant::now());
    }

    /// Forget what was learned, so the next look actually looks.
    ///
    /// Called from the gestures that mean "check again" — the user who just installed seedeep and
    /// pressed the panel's retry has no other way to say so, and the alternative is quitting the
    /// tray.
    pub fn forget(&self) {
        let mut cache = self.found.lock().unwrap();
        cache.path = None;
        cache.looked = None;
        // Never reset with `Lookup::default()`: that would put the generation back to zero, and the
        // whole point of the counter is that a look started before this call can tell.
        cache.generation += 1;
    }

    /// What the server on this machine needs to be talked to, read from the file it wrote them in.
    ///
    /// Called ONLY once a live record has proved a server is here and it has answered 401. That
    /// proof is what makes this legitimate, and it is the same one Stop already relies on: the tray
    /// trusts a live pid in this machine's directory enough to send it SIGTERM, and reading a file
    /// the same user owns is a weaker trust than that. `config.json` is `0600` and belongs to the
    /// user the tray runs as — anything learned here, that user's own shell can `cat`.
    ///
    /// The fingerprint comes from the certificate FILE, not from the handshake. That is the whole
    /// point: pinning exists so an identity presented over the wire is confirmed against something
    /// else, and here the something else is the file the server generated it in. It is the opposite
    /// of accepting a record because the network vouched for it.
    ///
    /// `None` when there is nothing to read — no config, a home the tray cannot see (`SEEDEEP_HOME`
    /// set in a shell profile, a documented limit), or a file that is not this shape.
    pub fn credentials(&self) -> Option<LocalCredentials> {
        let raw = fs::read_to_string(self.home.join("config.json")).ok()?;
        let config: ServerConfig = serde_json::from_str(&raw).ok()?;
        let fingerprint = config
            .tls
            .and_then(|t| t.cert)
            .map(|c| {
                // Absolute in every config the server writes; joined defensively so a relative one
                // is read from the home it was found in rather than from the tray's cwd.
                let path = PathBuf::from(&c);
                if path.is_absolute() { path } else { self.home.join(path) }
            })
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|pem| fingerprint_of_pem(&pem));
        let token = config.auth.and_then(|a| a.token).filter(|t| !t.is_empty());
        if token.is_none() && fingerprint.is_none() {
            return None;
        }
        Some(LocalCredentials { token, fingerprint })
    }

    /// Whether `base_url` is served BY this machine — the test for co-located, and the gate on
    /// Start.
    ///
    /// Two answers, in cost order. The spelling is free and conclusive when it matches. Otherwise
    /// the name is put to the resolver, which is where a server with remote access on lives: it
    /// announces the name it was configured with, and that name resolves here to loopback among its
    /// addresses. Reading only the spelling left Start missing for a server sitting on this very
    /// machine.
    ///
    /// Synchronous, like the rest of the poll's path, so a name it has not seen answers `false`
    /// once and starts a look — the same shape and the same reason as
    /// {@link LocalServer::look_soon}. Re-asked on {@link LOOKUP_RETRY} in BOTH directions: a name
    /// is not an executable, and a laptop that changes network changes what its own name resolves
    /// to.
    fn here(self: &Arc<Self>, base_url: &str) -> bool {
        if is_local(base_url) {
            return true;
        }
        let Some(host) = Url::parse(base_url).ok().and_then(|u| u.host_str().map(str::to_owned)) else {
            return false;
        };
        {
            let mut cache = self.resolved.lock().unwrap();
            match cache.get(&host) {
                // In flight, or an answer still worth trusting.
                Some((known, at)) if at.elapsed() < LOOKUP_RETRY => return known.unwrap_or(false),
                _ => cache.insert(host.clone(), (None, Instant::now())),
            };
        }
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            // `spawn_blocking`, because `getaddrinfo` blocks the thread it is called on and this
            // runtime's threads are what answer the panel.
            let answer = tokio::task::spawn_blocking({
                let host = host.clone();
                move || names_this_machine(&host)
            })
            .await
            .unwrap_or(false);
            me.resolved.lock().unwrap().insert(host, (Some(answer), Instant::now()));
        });
        false
    }

    /// What the panel may offer, given where the connection stands.
    ///
    /// Start appears only where nothing is answering HERE and there is something to run: a server
    /// that answered at all — even to refuse the token, even with the wrong certificate — is a
    /// server that is already running, and offering to start a second one on a taken port would
    /// produce a failure the user cannot act on.
    /// Synchronous on purpose: this is called from the poll's loop, which paints the icon and sends
    /// the notifications, and nothing in it may wait on a shell — see {@link LocalServer::look_soon}.
    pub fn survey(self: &Arc<Self>, status: &Status) -> Local {
        let startable = match status {
            // Nothing stored and nothing answered on loopback. `local_remote` is the exception: a
            // seedeep IS running here, it just wants its URL.
            Status::NeedsUrl { local_remote } => !*local_remote,
            Status::Offline { base_url, .. } => self.here(base_url),
            _ => false,
        };
        Local {
            // Not `match (startable, self.look_soon())`: a tuple is built before it is matched, so
            // that form ran the lookup even where Start can never be offered — a tray pointed at
            // another machine spawning a login shell every thirty seconds, forever, to answer a
            // question nobody asked.
            start: if !startable {
                Start::Elsewhere
            } else if self.look_soon().is_some() {
                Start::Ready
            } else {
                Start::NotInstalled { dev: DEV_BUILD }
            },
            can_stop: match status {
                Status::Connected { base_url, .. } => self.stoppable(base_url).is_ok(),
                _ => false,
            },
        }
    }

    /// The single process serving `base_url`, or why there is not one.
    ///
    /// Co-location is proven by the RECORD, never by the address. A server with remote access on
    /// announces the host it was configured with — measured on a real one, `https://<machine>:44842`
    /// — so a rule that read the URL would refuse to stop a server running on this very machine, and
    /// would be reasoning about a name resolution it has not performed. A live record in THIS
    /// machine's directory is the whole proof: the pid is one this kernel knows.
    ///
    /// The ambiguity is the case worth refusing rather than resolving: two live records claiming one
    /// address means a crashed server's file outlived it and the OS handed its pid to something
    /// else, and a stop that picked one of them would be a signal sent to an unrelated process. The
    /// user can see both files; the tray cannot tell them apart.
    fn stoppable(&self, base_url: &str) -> Result<RunningServer, String> {
        let mut matching: Vec<RunningServer> =
            self.running().into_iter().filter(|r| same_server(&r.base_url, base_url)).collect();
        match matching.len() {
            1 => Ok(matching.remove(0)),
            0 => Err("No server on this machine says it is serving that address.".into()),
            n => Err(format!(
                "{n} processes claim that address in {}. One of them is a record left by a server that \
                 crashed; delete it and try again.",
                self.home.join("servers").display()
            )),
        }
    }

    /// Start the server and wait until it says it is up.
    ///
    /// `port` is the one the panel NAMES, and `None` means "wherever its own config says". Start is
    /// offered under a screen showing an address, so it has to produce a server AT that address:
    /// with `http://127.0.0.1:9000` stored — an option the README documents — a bare spawn came up
    /// on the configured port instead, the panel stayed offline, and a second click launched a
    /// process that could not bind. Only `--port` is passed, never `--host`: locality is already
    /// proven by {@link is_local}, and an explicit host risks tipping the server into its
    /// non-loopback mode, where it demands TLS and a token.
    ///
    /// Success is a NEW record, never the spawn returning: what is on PATH may be npm's placeholder,
    /// and a port that was taken is a server that never existed. The child is held only for that
    /// window — long enough to notice it dying — and then handed to a task that waits on it, so a
    /// server the user later stops does not stay in the process table as a zombie the liveness check
    /// would go on reporting as alive.
    pub async fn start(&self, port: Option<u16>) -> Result<(), String> {
        let exe = self.executable().await.ok_or(
            "seedeep is not installed on this machine. Install it with `npm i -g seedeep`, or start it \
             yourself and the tray will find it.",
        )?;
        let args: Vec<String> = match port {
            Some(p) => vec!["--port".into(), p.to_string()],
            None => Vec::new(),
        };
        let before: HashSet<u32> = self.running().into_iter().map(|r| r.pid).collect();
        let log = self.log_path();
        fs::create_dir_all(&self.home)
            .map_err(|e| format!("Could not prepare {}: {e}", self.home.display()))?;
        let file = create_log(&log).map_err(|e| format!("Could not write {}: {e}", log.display()))?;
        let mut child = spawn_detached(&exe, &args, file)
            .map_err(|e| format!("seedeep could not be started: {e}"))?;

        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            sleep(STEP).await;
            if self.running().into_iter().any(|r| !before.contains(&r.pid)) {
                reap(child);
                return Ok(());
            }
            // After the record, never before: a server that announced itself and then exited did
            // start, and reporting the exit would be the tray contradicting the thing it asked for.
            if matches!(child.try_wait(), Ok(Some(_))) {
                return Err(self.why_it_stopped(&exe));
            }
            if Instant::now() >= deadline {
                reap(child);
                return Err(format!(
                    "seedeep started but did not answer within {} seconds. What it printed is in {}.",
                    START_TIMEOUT.as_secs(),
                    log.display()
                ));
            }
        }
    }

    /// Stop the server serving `base_url`, and wait for it to take its record back.
    ///
    /// The wait is what makes this honest: the signal returning says only that it was delivered, and
    /// a panel that went straight back to "not running" on that basis would be stating something it
    /// had not checked.
    pub async fn stop(&self, base_url: &str) -> Result<(), String> {
        let record = self.stoppable(base_url)?;
        ask_to_stop(record.pid).await?;
        let deadline = Instant::now() + STOP_TIMEOUT;
        loop {
            sleep(STEP).await;
            if !self.running().iter().any(|r| r.pid == record.pid) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "seedeep was asked to stop and is still running after {} seconds.",
                    STOP_TIMEOUT.as_secs()
                ));
            }
        }
    }

    /// Why a start that exited did so, in one line the panel can show.
    ///
    /// The first line of what it printed, which for the placeholder is the sentence that names the
    /// problem — "the native binary was not installed" — and for anything else is whatever the
    /// server itself said. The rest is not dropped; it is in the file, and the message says where.
    fn why_it_stopped(&self, exe: &Path) -> String {
        let log = self.log_path();
        let said = fs::read_to_string(&log)
            .ok()
            .and_then(|raw| raw.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string));
        match said {
            Some(line) => format!("{line} ({}). The rest is in {}.", exe.display(), log.display()),
            None => format!("{} started and stopped immediately, saying nothing.", exe.display()),
        }
    }
}

/// Wait on a child that is no longer being watched, so it cannot become a zombie.
///
/// Not a detail: on unix a process whose parent never reaps it stays in the table as `<defunct>`,
/// and `kill(pid, 0)` succeeds for exactly that — so a stopped server would go on being reported as
/// running for as long as the tray lived. Nothing here signals the child; waiting is all it does.
fn reap(mut child: Child) {
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn tmp_dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "seedeep-tray-local-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(dir.join("servers")).unwrap();
        dir
    }

    fn write_record(home: &Path, pid: u32, base_url: &str) {
        fs::write(
            home.join("servers").join(format!("{pid}.json")),
            format!(r#"{{"pid":{pid},"baseUrl":"{base_url}"}}"#),
        )
        .unwrap();
    }

    /// A pid that is certainly alive and certainly not a seedeep: this process.
    fn me() -> u32 {
        std::process::id()
    }

    // The bases come from `temp_dir()` rather than being written as `/home/dev`, and that is not
    // cosmetic: `seedeep_home` makes the override ABSOLUTE, and `/tmp/elsewhere` is not an absolute
    // path on Windows — it has no drive — so a literal turns the identity case into a resolution
    // against the process's cwd and the assertion is about the machine that ran it.
    #[test]
    fn the_home_is_the_seedeep_directory_unless_the_variable_moves_it() {
        let home = std::env::temp_dir().join("seedeep-home");
        let elsewhere = std::env::temp_dir().join("seedeep-elsewhere");
        assert_eq!(seedeep_home(home.clone(), None), home.join(".seedeep"));
        assert_eq!(seedeep_home(home.clone(), Some(elsewhere.clone().into())), elsewhere);
        // A script that exported the name and forgot the value must not point the tray at the
        // process's cwd — the same trap `config_root` documents for the tray's own files.
        assert_eq!(seedeep_home(home.clone(), Some("".into())), home.join(".seedeep"));
    }

    // Co-location is a fact about the address, and the four spellings of this machine all count.
    // A hostname that happens to resolve here does not: the tray would be claiming a mapping it
    // has not checked, and getting it wrong means signalling a pid on the strength of a guess.
    #[test]
    fn only_a_loopback_address_is_this_machine() {
        for url in ["http://127.0.0.1:44842", "http://localhost:9000", "https://[::1]:44842"] {
            assert!(is_local(url), "{url}");
        }
        for url in ["https://box.local:44842", "https://10.0.0.4:44842", "not a url"] {
            assert!(!is_local(url), "{url}");
        }
    }

    #[test]
    fn a_record_is_read_when_its_process_is_there() {
        let home = tmp_dir();
        write_record(&home, me(), "http://127.0.0.1:44842");

        let found = LocalServer::new(home).running();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pid, me());
        assert_eq!(found[0].base_url, "http://127.0.0.1:44842");
    }

    // The record outlives a crash, and after enough of them the OS hands that pid to something
    // else. Everything downstream of this list is a signal, so a dead pid must never reach it.
    #[test]
    fn a_record_whose_process_is_gone_is_not_a_server() {
        let home = tmp_dir();
        // The two dangerous ones, and neither is a process: `kill` reads a non-positive argument as
        // a process GROUP. 0 is the tray's own — a record named `0.json` reading as alive would end
        // with the tray signalling itself — and 4294967295 wraps to -1, which is every process this
        // user can signal. These assertions are what stand between a malformed file and that.
        write_record(&home, 0, "http://127.0.0.1:44842");
        write_record(&home, u32::MAX, "http://127.0.0.1:44842");
        // Nor is a file that says one thing and is named another.
        fs::write(
            home.join("servers").join(format!("{}.json", me())),
            format!(r#"{{"pid":{},"baseUrl":"http://127.0.0.1:1"}}"#, me() + 1),
        )
        .unwrap();
        fs::write(home.join("servers").join("notes.txt"), "not a record").unwrap();

        assert_eq!(LocalServer::new(home).running(), Vec::new());
    }

    #[test]
    fn a_missing_directory_is_no_servers_rather_than_an_error() {
        assert_eq!(LocalServer::new(PathBuf::from("/nonexistent/seedeep")).running(), Vec::new());
    }

    // The case the ambiguity rule exists for. Two live records claiming one address is a crashed
    // server's file plus a recycled pid, and picking either would signal a process that is not a
    // server. Refusing says so; resolving it would be a guess with a `kill` at the end.
    // The one seam nothing else covers: the panel reads these two names off a JSON payload, and a
    // rename here would not fail to compile — it would silently draw no button, on the only screen
    // that has one. `connection.ts` declares the same pair.
    #[test]
    fn the_panel_reads_these_names() {
        let ready = serde_json::to_string(&Local { start: Start::Ready, can_stop: false }).unwrap();
        assert_eq!(ready, r#"{"start":{"kind":"ready"},"canStop":false}"#);

        // The reason a boolean was not enough, and the shape the connection screen switches on.
        let missing =
            serde_json::to_string(&Local { start: Start::NotInstalled { dev: true }, can_stop: true })
                .unwrap();
        assert_eq!(missing, r#"{"start":{"kind":"notInstalled","dev":true},"canStop":true}"#);
    }

    #[cfg(unix)]
    #[test]
    fn two_processes_claiming_one_address_stop_neither() {
        let home = tmp_dir();
        write_record(&home, me(), "http://127.0.0.1:44842");
        // The parent of this process: alive by construction, and not a seedeep.
        let other = unsafe { libc::getppid() } as u32;
        write_record(&home, other, "http://127.0.0.1:44842");

        let err = LocalServer::new(home).stoppable("http://127.0.0.1:44842").unwrap_err();

        assert!(err.contains('2'), "{err}");
        assert!(err.contains("crashed"), "the refusal has to say what to do: {err}");
    }

    // A server on another machine leaves no record here, and that — not the shape of its URL — is
    // what makes it unstoppable. The message says which fact is missing.
    #[test]
    fn a_server_that_left_no_record_here_is_not_stoppable() {
        let home = tmp_dir();
        write_record(&home, me(), "http://127.0.0.1:44842");

        let err = LocalServer::new(home).stoppable("https://box.local:44842").unwrap_err();

        assert!(err.contains("No server on this machine"), "{err}");
    }

    // THE default case, and the one this shipped broken: the server in loopback mode announces
    // `http://localhost:<port>` while the tray's zero-configuration connection is
    // `http://127.0.0.1:44842`. Compared as strings they are two servers, so Stop never appeared for
    // the very server Start had just launched — and no test saw it, because every fixture wrote the
    // spelling the code expected.
    #[test]
    fn localhost_and_127_0_0_1_are_one_server() {
        let home = tmp_dir();
        write_record(&home, me(), "http://localhost:44842");

        let found = LocalServer::new(home).stoppable("http://127.0.0.1:44842").unwrap();

        assert_eq!(found.pid, me());
    }

    // The equivalence is loopback's alone, and it is not "any two URLs that look similar": a
    // different port is a different process, and a different scheme is a different server.
    #[test]
    fn only_loopback_spellings_collapse() {
        assert!(same_server("http://localhost:44842", "http://[::1]:44842"));
        assert!(same_server("https://box.local:44842", "https://box.local:44842"));
        assert!(!same_server("http://localhost:44842", "http://localhost:9000"));
        assert!(!same_server("http://localhost:44842", "https://localhost:44842"));
        assert!(!same_server("http://localhost:44842", "http://box.local:44842"));
        assert!(!same_server("not a url", "not a url"), "two unparseable strings are not a server");
    }

    // The case that broke the first rule, met on a real machine: a seedeep with remote access on
    // announces the host it was CONFIGURED with, not loopback. It is running here all the same, its
    // pid is one this kernel knows, and refusing to stop it because its URL has a hostname in it
    // would be the tray reasoning about a name resolution it never performed.
    #[test]
    fn a_local_server_in_remote_mode_is_still_this_machines() {
        let home = tmp_dir();
        write_record(&home, me(), "https://this-machine.local:44842");

        let found = LocalServer::new(home).stoppable("https://this-machine.local:44842").unwrap();

        assert_eq!(found.pid, me());
    }

    // The panel draws Start from this, so the states have to be exactly the ones where nothing is
    // running here. A server that answered — even to refuse the token, even with a certificate the
    // tray will not accept — is running, and starting a second one on a taken port fails in a way
    // the user cannot act on.
    #[test]
    fn start_is_offered_only_where_nothing_is_answering_here() {
        let local = Arc::new(LocalServer::new(tmp_dir()));
        // Pinned, so the test is about the RULE and not about whether this machine has seedeep on
        // its PATH — which decides the other half of `can_start` and is not what is under test. It
        // also keeps `look_soon` from starting a background look this test has no runtime for.
        local.found.lock().unwrap().path = Some(PathBuf::from("/usr/bin/true"));

        let startable = |s: Status| local.survey(&s).start == Start::Ready;

        assert!(startable(Status::NeedsUrl { local_remote: false }));
        assert!(startable(Status::Offline {
            base_url: "http://127.0.0.1:44842".into(),
            detail: "Connection refused".into()
        }));
        // A seedeep IS running here, in remote mode: it needs a URL, not a second process.
        assert!(!startable(Status::NeedsUrl { local_remote: true }));
        // Answering from another machine — nothing here to start, and nothing here that would help.
        assert!(!startable(Status::Offline {
            base_url: "https://box.local:44842".into(),
            detail: "No answer".into()
        }));
        assert!(!startable(Status::Unauthorized { base_url: "http://127.0.0.1:44842".into() }));
        assert!(!startable(Status::Connected {
            base_url: "http://127.0.0.1:44842".into(),
            fingerprint: None
        }));
    }

    // Without a path there is no button, whatever the status says: an affordance that cannot work
    // is worse than its absence, and the throttle means one look answers for the next 30 seconds.
    #[test]
    fn nothing_to_run_is_nothing_to_offer() {
        let local = Arc::new(LocalServer::new(tmp_dir()));
        // A look that has just happened and found nothing: the throttle answers for the next 30 s,
        // so this asks the cache rather than a shell.
        local.found.lock().unwrap().looked = Some(Instant::now());

        // Not `Elsewhere`: this machine COULD run one, there is simply nothing installed — and the
        // panel needs that difference to say something the user can act on.
        assert_eq!(
            local.survey(&Status::NeedsUrl { local_remote: false }).start,
            Start::NotInstalled { dev: DEV_BUILD }
        );
    }

    #[test]
    fn stop_is_offered_for_the_connected_server_and_only_it() {
        let home = tmp_dir();
        // The spelling the SERVER writes in loopback mode, against the one the tray connects with.
        write_record(&home, me(), "http://localhost:44842");
        let local = Arc::new(LocalServer::new(home));

        let connected = |url: &str| Status::Connected { base_url: url.into(), fingerprint: None };
        assert!(local.survey(&connected("http://127.0.0.1:44842")).can_stop);
        // The same machine, another port: a different process, and not the one on screen.
        assert!(!local.survey(&connected("http://127.0.0.1:9000")).can_stop);
        // Reachable but not read: nothing corroborates which process is answering.
        assert!(!local.survey(&Status::Unauthorized { base_url: "http://127.0.0.1:44842".into() }).can_stop);
    }

    // `command -v` answers with a path, but an interactive shell is entitled to print its own
    // things first, and for a shell FUNCTION it prints the body instead. Only a file on disk is an
    // answer to where seedeep is.
    // The file is CREATED rather than borrowed from the system, because `first_executable` asks the
    // real filesystem and the two platforms have nothing in common to point it at: `/usr/bin/true`
    // does not exist on Windows, and there a name also has to end in an extension `cmd` can run.
    // `.exe` satisfies that and means nothing on unix, so one name serves both.
    #[test]
    fn only_a_real_file_counts_as_having_found_it() {
        let dir = std::env::temp_dir().join(format!("seedeep-which-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let real = dir.join("seedeep.exe");
        fs::write(&real, b"not really a program").unwrap();
        let absent = dir.join("no-such-seedeep.exe");

        assert_eq!(first_executable(""), None);
        assert_eq!(first_executable("seedeep () {\n\techo hi\n}\n"), None);
        assert_eq!(first_executable(&format!("{}\n", absent.display())), None, "a path is not a file");
        // A login shell is entitled to print a motd, and the answer may be the second line.
        assert_eq!(
            first_executable(&format!("Welcome back!\n  {}  \n{}\n", real.display(), absent.display())),
            Some(real.clone())
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// Live: find the real seedeep through the user's own shell, start it, and stop it again.
    ///
    /// `#[ignore]`d and gated on a variable, like the pinning probes in `client.rs` and for the same
    /// reason — the claim is about a real executable, found through a real shell, announcing itself
    /// in the real home. Nothing hermetic can make it, and a claim that cannot be re-run on a later
    /// macOS or bun release is one that quietly expires.
    ///
    /// It reads the user's real config, so the address it comes up on is whatever that config says —
    /// asserted from the record rather than assumed to be loopback, which is the mistake the first
    /// version of this probe made against a machine in remote mode. Run it with nothing else on the
    /// port that config names.
    ///
    /// ```sh
    /// SEEDEEP_TRAY_PROBE_START=1 cargo test -- --ignored --nocapture a_real_server_starts_and_stops
    /// ```
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "starts and stops a real server on 44842: set SEEDEEP_TRAY_PROBE_START=1"]
    async fn a_real_server_starts_and_stops() {
        assert!(
            std::env::var_os("SEEDEEP_TRAY_PROBE_START").is_some(),
            "set SEEDEEP_TRAY_PROBE_START=1 to say it may start a server on this machine"
        );
        // `SEEDEEP_HOME` honoured here, unlike in the app: it lets the probe run against a DEFAULT
        // config — the loopback case, where the server announces `localhost` and the tray connects
        // to `127.0.0.1`. That is the pair the exact-match rule got wrong, and a probe that only
        // ever ran against this machine's own remote-mode config never touched it.
        let home = seedeep_home(
            PathBuf::from(std::env::var("HOME").unwrap()),
            std::env::var_os("SEEDEEP_HOME"),
        );
        let local = Arc::new(LocalServer::new(home.clone()));
        let exe = local.executable().await.expect("the shell found no seedeep on PATH");
        println!("found: {}", exe.display());
        assert!(local.running().is_empty(), "something is already running — stop it first");

        // `None`: this probe is about the default world, so the server's own config picks the port.
        local.start(None).await.expect("start");

        let up = local.running();
        assert_eq!(up.len(), 1, "exactly one server announced itself: {up:?}");
        let served = up[0].base_url.clone();
        println!("started: pid {} on {served}", up[0].pid);
        // The log is where the fingerprint and the URL land, and in remote mode that URL carries the
        // token. Asserted on the bits, because "we asked for 0600" is not "the file on disk is".
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(local.log_path()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "the log can hold the token");
        }
        // Something really is listening. At TCP level and not through HTTP: the address may be
        // https with a self-signed certificate, and what is under test here is the bind.
        let target = Url::parse(&served).unwrap();
        let addr = format!("{}:{}", target.host_str().unwrap(), target.port().unwrap());
        std::net::TcpStream::connect(&addr).unwrap_or_else(|e| panic!("nothing on {addr}: {e}"));

        // Found with NOTHING stored, which is the capability the record buys: `Conn` has no URL, no
        // port to guess that would work, and only the announcement to go on. Run the probe with
        // `SEEDEEP_PORT=44843` — the server inherits it — and this is the assertion that fails
        // without the record being read, because 44842 is then the wrong guess and the only one.
        let conn = crate::client::Conn::new(home.join("probe-connection.json"), Arc::clone(&local));
        match conn.status().await {
            crate::client::Status::Connected { base_url, .. } => assert_eq!(base_url, served),
            other => panic!("the announced server was not adopted: {other:?}"),
        }

        // Stopped through the address the TRAY holds, not the one the record carries: for a default
        // local server those are two spellings of one machine, and stopping by the record's own
        // string would be the probe agreeing with the code instead of checking it.
        let aimed_at = match Url::parse(&served) {
            // The same server, spelled the way the tray holds it. Only the HOST is swapped: an
            // earlier version substituted the whole default address and aimed 44843's stop at
            // 44842, which is the probe agreeing with a guess instead of checking one.
            Ok(url) if is_local(&served) => {
                format!("{}://127.0.0.1:{}", url.scheme(), url.port_or_known_default().unwrap())
            }
            _ => served.clone(),
        };
        println!("stopping via {aimed_at} (announced as {served})");
        local.stop(&aimed_at).await.expect("stop");

        assert!(local.running().is_empty(), "the record survived the stop");
        assert!(
            std::net::TcpStream::connect(&addr).is_err(),
            "{addr} is still answering, so the process is still there"
        );
    }

    // The token reaches this file: a server in remote mode prints its URL with `?token=` in it, and
    // the same secret is kept at 0600 in the config beside it. Twice, because `mode()` on
    // `OpenOptions` does nothing to a file that already exists — which is exactly the state a log
    // written by an earlier version leaves behind.
    #[cfg(unix)]
    #[test]
    fn the_log_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir();
        let path = dir.join("server.log");
        fs::write(&path, "left by an older version").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        create_log(&path).unwrap();

        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_to_string(&path).unwrap(), "", "each start begins its own log");
    }

    // `where.exe seedeep` lists npm's three shims and the extensionless sh script comes FIRST, so
    // "the first existing file" would hand `cmd /C` something it cannot start — a Start that fails
    // with a cmd error on the one platform this was never run on. The rule is tested here even
    // though it only takes effect there.
    #[test]
    fn on_windows_only_what_cmd_can_start_counts() {
        for good in ["C:\\bin\\seedeep.cmd", "C:\\bin\\seedeep.EXE", "C:\\bin\\seedeep.bat"] {
            assert!(cmd_can_run(Path::new(good)), "{good}");
        }
        for bad in ["C:\\bin\\seedeep", "C:\\bin\\seedeep.ps1", "C:\\bin\\seedeep.sh"] {
            assert!(!cmd_can_run(Path::new(bad)), "{bad}");
        }
    }

    // The whole point of going through a shell rather than exec'ing the file: npm's placeholder
    // carries no shebang, `execve` answers ENOEXEC, and the four lines it exists to print would
    // never be seen. Asserted end to end, because the claim is about the platform and not about us.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_file_with_no_shebang_still_gets_to_speak() {
        let home = tmp_dir();
        let placeholder = home.join("seedeep.exe");
        fs::write(&placeholder, "echo 'the native binary was not installed.' >&2\nexit 1\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&placeholder, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let local = LocalServer::new(home);
        local.found.lock().unwrap().path = Some(placeholder);

        let err = local.start(None).await.unwrap_err();

        assert!(err.contains("the native binary was not installed"), "{err}");
        assert!(!err.contains("Exec format"), "the OS error is not what the user needs: {err}");
    }

    /// A look that was already stale when it landed does not get to speak. The user installs
    /// seedeep while a cold shell is still running and presses *Look again*: the warm one answers
    /// first, and the slow one must not then erase the path AND re-stamp the throttle, which is a
    /// button that vanishes for the next thirty seconds.
    #[tokio::test]
    async fn a_look_that_the_user_overtook_cannot_write_its_answer() {
        let local = LocalServer::new(tmp_dir());
        let stale = local.found.lock().unwrap().generation;

        // The gesture: forget, then a fresh look that finds it.
        local.forget();
        let fresh = local.found.lock().unwrap().generation;
        local.remember(Some(PathBuf::from("/opt/seedeep")), fresh);

        // The shell that was already running comes back with its "no".
        local.remember(None, stale);

        let cache = local.found.lock().unwrap();
        assert_eq!(cache.path, Some(PathBuf::from("/opt/seedeep")));
        assert!(cache.looked.is_some(), "the fresh answer keeps its stamp");
    }

    /// A gesture is not the poll: it never accepts a remembered "no", while the poll does. Asserted
    /// on the policies rather than through `executable`, which would spawn the developer's own
    /// login+interactive shell inside the suite.
    #[test]
    fn a_click_re_asks_the_no_that_the_poll_is_happy_with() {
        let fresh_miss = Lookup {
            path: None,
            looked: Some(Instant::now()),
            generation: 0,
        };
        assert_eq!(fresh_miss.for_the_poll(), Some(None), "the poll must not spawn a shell a tick later");
        assert_eq!(fresh_miss.for_a_click(), None, "the click has to look again");

        let stale_miss = Lookup {
            path: None,
            looked: Instant::now().checked_sub(LOOKUP_RETRY * 2),
            generation: 0,
        };
        assert_eq!(stale_miss.for_the_poll(), None, "past the retry, even the poll looks again");

        // A path that was found is enough for both — an executable does not move.
        let found = Lookup {
            path: Some(PathBuf::from("/opt/seedeep")),
            looked: Some(Instant::now()),
            generation: 0,
        };
        assert_eq!(found.for_the_poll(), Some(Some(PathBuf::from("/opt/seedeep"))));
        assert_eq!(found.for_a_click(), Some(PathBuf::from("/opt/seedeep")));
    }

    /// The lookup is not run where Start can never be offered. It spawns a login+interactive shell,
    /// and a tray pointed at another machine was paying for one every thirty seconds, forever, to
    /// answer a question its screen would never ask.
    #[test]
    fn a_tray_pointed_elsewhere_never_runs_a_shell() {
        let local = Arc::new(LocalServer::new(tmp_dir()));
        let elsewhere = Status::Offline {
            base_url: "http://192.168.1.9:44842".into(),
            detail: String::new(),
        };

        let seen = local.survey(&elsewhere);

        assert_eq!(seen.start, Start::Elsewhere);
        assert!(local.found.lock().unwrap().looked.is_none(), "it looked anyway");
    }

    /// Only a plaintext record is adopted on sight. An `https://` one would be trusted with no
    /// fingerprint — learning mode — which is the confirmation `Conn::connect` refuses to skip.
    #[test]
    fn only_a_plaintext_address_may_be_adopted() {
        assert!(is_plaintext("http://127.0.0.1:44842"));
        assert!(!is_plaintext("https://desktop.local:44842"));
        assert!(!is_plaintext("file:///etc/passwd"));
        assert!(!is_plaintext("not a url"));
    }

    /// The same certificate reached two ways: wrapped as PEM and read from a file, or handed to the
    /// verifier as DER. The tray pins what the FILE says, so the two roads have to arrive at one
    /// fingerprint — and the oracle is openssl's own output, not this module agreeing with itself.
    #[test]
    fn a_pem_and_its_der_have_one_fingerprint() {
        const LEAF: &[u8] = include_bytes!("../tests/fixtures/leaf.der");
        const LEAF_SHA256: &str =
            "06:EB:C5:8D:72:53:3F:C3:15:26:9D:5A:66:1B:10:E7:26:CB:52:52:90:1E:4E:DF:FA:1B:11:93:E6:E0:70:A4";
        let body = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, LEAF);
        // Wrapped at 64 columns and with the trailing newline a real PEM carries, since the decoder
        // has to survive the whitespace rather than a single line it was handed by a test.
        let wrapped: Vec<String> = body.as_bytes().chunks(64).map(|c| String::from_utf8_lossy(c).into_owned()).collect();
        let pem = format!(
            "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
            wrapped.join("\n")
        );

        assert_eq!(fingerprint_of_pem(&pem).as_deref(), Some(LEAF_SHA256));
        assert_eq!(fingerprint_of_pem("not a certificate at all"), None);
    }

    /// The tray reads the co-located server's credentials from the file it wrote them in — the
    /// alternative was sending the user to copy a URL from a portal on "the machine running
    /// seedeep", which is the machine they are already looking at.
    #[test]
    fn the_local_config_hands_over_the_token_and_the_fingerprint() {
        const LEAF: &[u8] = include_bytes!("../tests/fixtures/leaf.der");
        const LEAF_SHA256: &str =
            "06:EB:C5:8D:72:53:3F:C3:15:26:9D:5A:66:1B:10:E7:26:CB:52:52:90:1E:4E:DF:FA:1B:11:93:E6:E0:70:A4";
        let home = tmp_dir();
        let cert = home.join("cert.pem");
        let body = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, LEAF);
        fs::write(&cert, format!("-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----\n")).unwrap();
        // Built with the JSON encoder rather than formatted into a string: a Windows path is full
        // of backslashes, `\U` is not a JSON escape, and a hand-written literal produces a file the
        // parser rejects — so `credentials()` returned nothing and the test blamed the code.
        let config = serde_json::json!({
            "port": 44842,
            "host": "0.0.0.0",
            "auth": { "token": "a-token" },
            "tls": { "commonName": "host.local", "cert": cert, "key": "k" },
        });
        fs::write(home.join("config.json"), config.to_string()).unwrap();

        let known = LocalServer::new(home).credentials().expect("a config the tray can read");

        assert_eq!(known.token.as_deref(), Some("a-token"));
        assert_eq!(known.fingerprint.as_deref(), Some(LEAF_SHA256));
    }

    /// A loopback server has neither, and there is then nothing to hand over — the plaintext probe
    /// already reaches it without asking anyone.
    #[test]
    fn a_config_with_nothing_to_offer_hands_over_nothing() {
        let home = tmp_dir();
        fs::write(home.join("config.json"), r#"{"port":44842,"host":"127.0.0.1"}"#).unwrap();
        assert_eq!(LocalServer::new(home).credentials(), None);

        // And a home with no config at all — a `SEEDEEP_HOME` the tray cannot see.
        assert_eq!(LocalServer::new(tmp_dir()).credentials(), None);
    }

    /// Co-location is decided by IDENTITY, not by spelling. A server with remote access on announces
    /// the name it was configured with, and this machine's own name resolves here to loopback — so
    /// reading only the spelling left Start missing for a server sitting right there.
    ///
    /// Asserted on names that need no network: the machine's own, which every resolver answers, and
    /// a name that cannot resolve at all.
    #[test]
    fn a_name_that_resolves_here_is_this_machine() {
        assert!(names_this_machine("localhost"));
        assert!(names_this_machine("127.0.0.1"));
        assert!(!names_this_machine(""), "nothing is not a host");
    }

    /// The claim the whole rule rests on, put to a real machine: its own name resolves, HERE, to an
    /// address it holds. Ignored because the answer belongs to this machine's networking rather than
    /// to the code — measured on macOS as `::1`, `127.0.0.1` and the LAN address, in 4.5 ms.
    ///
    /// ```sh
    /// SEEDEEP_TRAY_PROBE_HOSTNAME=$(hostname) cargo test -- --ignored --nocapture a_machine_answers
    /// ```
    #[test]
    #[ignore = "machine-dependent: SEEDEEP_TRAY_PROBE_HOSTNAME=$(hostname) cargo test -- --ignored"]
    fn a_machine_answers_to_its_own_name() {
        let Some(name) = std::env::var_os("SEEDEEP_TRAY_PROBE_HOSTNAME") else {
            panic!("set SEEDEEP_TRAY_PROBE_HOSTNAME to this machine's name")
        };
        let name = name.to_string_lossy().into_owned();
        println!("{name} → {}", if names_this_machine(&name) { "this machine" } else { "SOMEWHERE ELSE" });
        assert!(names_this_machine(&name), "{name} did not resolve to an address this machine holds");
    }

    /// The spelling test still answers instantly, which is what keeps the resolver off the poll's
    /// path for the common case.
    #[test]
    fn the_spelling_is_answered_without_asking_anyone() {
        let local = Arc::new(LocalServer::new(tmp_dir()));
        for url in ["http://127.0.0.1:44842", "http://localhost:9000", "http://[::1]:44842"] {
            assert!(local.here(url), "{url}");
        }
        // An unseen name cannot be answered synchronously — it starts a look and says no for now,
        // which is the same contract `look_soon` has and for the same measured reason.
        assert!(!local.here("https://a-machine-elsewhere.example:44842"));
    }

    /// The port the panel names REACHES the process. Start sits under a screen saying that address
    /// is not answering, and a bare spawn came up on the configured port instead: the panel stayed
    /// offline, and clicking again launched something that could not bind.
    ///
    /// Asserted through the spawn, on what the child actually received — the `sh -c 'exec "$0" "$@"'`
    /// form has to forward the flags, and a rule about `Vec<String>` would not have noticed if it
    /// stopped doing so.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_port_the_panel_names_reaches_the_server() {
        let home = tmp_dir();
        let echo = home.join("seedeep");
        fs::write(&echo, "#!/bin/sh\necho \"argv: $*\" >&2\nexit 1\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&echo, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let local = LocalServer::new(home);
        local.found.lock().unwrap().path = Some(echo);

        let err = local.start(Some(9000)).await.unwrap_err();
        assert!(err.contains("argv: --port 9000"), "{err}");

        // And nothing at all when there is no address to honour, so a user whose `config.json`
        // names a port still gets that one.
        let err = local.start(None).await.unwrap_err();
        assert!(err.contains("argv:"), "the placeholder did not run: {err}");
        assert!(!err.contains("--port"), "a flag was passed with no address to honour: {err}");
    }
}
