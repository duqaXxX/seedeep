/**
 * Settings panel — global drawer for configuring seedeep via /api/config.
 * One instance; mounted once by app.ts into the page header.
 */

import { isValidCertName } from '../core/cert-name.ts';
import { authFetch, getToken, setToken } from './auth.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export function isLoopback(h: string): boolean {
  return !h.trim() || LOOPBACK.has(h.trim());
}

/** 32-byte base64url token, generated client-side on Regen. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Given the current host and CN input, return what the save button and TLS section
 * should do — pure function of form state, no DOM involved.
 *
 * `cnError` is the message to show under the field, empty when there is nothing wrong. It is
 * returned rather than decided at the DOM site so the panel and this function cannot disagree
 * about when the field is bad — the reason the CN rule is checked in exactly one place.
 */
export function resolveFormState(
  host: string,
  cn: string,
): {
  remote: boolean; // non-loopback host → show banner + TLS section
  canSave: boolean; // false when remote but the CN is missing or unusable
  cnError: string;
} {
  const remote = !isLoopback(host);
  const trimmed = cn.trim();
  let cnError = '';
  if (remote && !trimmed) cnError = 'Required to enable remote access';
  // Checked client-side as well as server-side so the field says so immediately, and with the
  // SAME predicate — a panel that accepts what the server refuses is worse than no check.
  else if (trimmed && !isValidCertName(trimmed)) {
    cnError = 'A hostname or IPv4 address: letters, digits, hyphens and dots only';
  }
  return { remote, canSave: !cnError, cnError };
}

/**
 * Build the JSON body for POST /api/config from the current form values.
 * `pendingToken` is included only when the user generated a new one (non-empty).
 */
export function buildSaveBody(
  port: number,
  host: string,
  open: boolean,
  cn: string,
  pendingToken: string,
  webhook?: WebhookForm,
  tray?: NotifyChannelSwitches,
): Record<string, unknown> {
  const body: Record<string, unknown> = { port, host, open };
  if (cn.trim()) body['tls'] = { commonName: cn.trim() };
  if (pendingToken) body['auth'] = { token: pendingToken };
  if (webhook) {
    // `headersText` is FORM state, not config: sending it would write a key the server never reads
    // into the user's config.json and leave it there for good.
    const { headersText, ...rest } = webhook;
    body['notifications'] = { webhook: { ...rest, headers: parseHeaders(headersText) } };
  }
  if (tray) {
    const n = (body['notifications'] ?? {}) as Record<string, unknown>;
    body['notifications'] = { ...n, tray };
  }
  return body;
}

/** Which events one channel is allowed to interrupt for. Both channels carry the same four. */
export interface NotifyChannelSwitches {
  needsYou: boolean;
  fails: boolean;
  finishes: boolean;
  updates: boolean;
}

/** The webhook half of the form, as the panel holds it before it becomes a request body. */
export interface WebhookForm {
  url: string;
  headersText: string;
  template: string;
  needsYou: boolean;
  fails: boolean;
  finishes: boolean;
  updates: boolean;
}

/**
 * `Name: value` per line into the object the server stores.
 *
 * A line without a colon is DROPPED rather than guessed at: a header with no name is not a header,
 * and inventing one would send it to the user's service without them having written it.
 */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    if (name) out[name] = line.slice(at + 1).trim();
  }
  return out;
}

/** The stored headers back into the one-per-line text the field shows. */
export function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

const SLIDERS_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
  <line x1="2" y1="4" x2="14" y2="4"/>
  <circle cx="5.5" cy="4" r="1.8" fill="currentColor" stroke="none"/>
  <line x1="2" y1="8" x2="14" y2="8"/>
  <circle cx="10.5" cy="8" r="1.8" fill="currentColor" stroke="none"/>
  <line x1="2" y1="12" x2="14" y2="12"/>
  <circle cx="7" cy="12" r="1.8" fill="currentColor" stroke="none"/>
</svg>`;

const WARN_SVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 8a1 1 0 110-2 1 1 0 010 2z"/>
</svg>`;

const RESTART_SVG = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M8 3a5 5 0 104.546 2.914.5.5 0 01.908-.417A6 6 0 118 2v1z"/>
  <path d="M8 4.466V.534a.25.25 0 01.41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 018 4.466z"/>
</svg>`;

interface ConfigResponse {
  port: number;
  host: string;
  open: boolean;
  /** The release the RUNNING server is — never the version this bundle was built from, which a
   * stale `build:client` would make a different number. */
  version?: string;
  /** `fingerprint` is present only when the RUNNING server is serving TLS — a host typed into
   * the form but not yet restarted into has no certificate to describe. */
  tls?: { commonName?: string; fingerprint?: string };
  /** Header VALUES arrive redacted — this endpoint answers without auth. See `load()`. */
  notifications?: {
    tray?: { needsYou?: boolean; fails?: boolean; finishes?: boolean; updates?: boolean };
    webhook?: {
      url?: string;
      headers?: Record<string, string>;
      template?: string;
      needsYou?: boolean;
      fails?: boolean;
      finishes?: boolean;
      updates?: boolean;
    };
  };
  restart_required?: boolean;
}

interface SavedState {
  port: string;
  host: string;
  open: boolean;
  cn: string;
}

/**
 * Mount the settings button in `headerEl` and wire up the global settings drawer.
 * Called once from app.ts; the drawer lives at `document.body` level so it is above
 * per-session overlays (which are fixed children of `.panel` containers).
 */
export function createSettingsPanel(headerEl: HTMLElement): void {
  // Token generated client-side on Regen; empty means "use whatever the server has".
  let pendingToken = '';
  // The state when the drawer was last loaded/saved — used by Discard.
  let savedState: SavedState | null = null;
  let dirty = false;

  // ── header button ──────────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.className = 'settings-btn';
  btn.title = 'Settings';
  btn.setAttribute('aria-label', 'Open settings');
  btn.innerHTML = SLIDERS_SVG; // safe: hardcoded constant SVG, no user/server data
  headerEl.append(btn);

  // ── overlay (scrim + drawer) ───────────────────────────────────────────────
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  document.body.append(scrim);

  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', 'Settings');
  // safe: hardcoded template — all SVG/HTML constants, no user or server data interpolated.
  // Server data is only ever written via .value / .textContent after load().
  drawer.innerHTML = `
<button class="close" aria-label="Close settings">×</button>
<div class="dhead">
  <div class="deyebrow"><span class="dchip">config</span></div>
  <h3>Settings</h3>
</div>
<div class="sbanner" id="s-banner" style="display:none">
  ${WARN_SVG}
  <div>
    <strong>Remote access enabled</strong>
    HTTPS and token authentication are required. Your browser will show a
    certificate warning on first visit — add a one-time exception.
  </div>
</div>
<div class="block" style="margin-top:.85rem">
  <div class="blabel">Network</div>
  <div class="srow">
    <div class="slabel">Port<small>Requires restart</small></div>
    <input id="s-port" class="sinput" type="number" min="1" max="65535">
  </div>
  <div class="srow">
    <div class="slabel">Host<small>Requires restart</small></div>
    <input id="s-host" class="sinput" type="text" placeholder="127.0.0.1">
  </div>
  <div class="srow">
    <div class="slabel">Open browser on start</div>
    <div class="stoggle-wrap">
      <div id="s-open-track" class="stoggle-track"><div class="stoggle-thumb"></div></div>
      <span id="s-open-label" class="stoggle-label">Yes</span>
    </div>
  </div>
</div>
<div class="block">
  <div class="blabel">Security</div>
  <div class="srow">
    <div class="slabel">Auth token<small>Active in remote mode</small></div>
    <div>
      <div class="stoken-wrap">
        <input id="s-token" class="sinput" type="password" readonly autocomplete="off" value="***">
        <button id="s-regen" class="xbtn">Regen</button>
      </div>
      <div id="s-token-note" class="sinput-note" style="display:none">Saving this locks out every other
        browser and client still holding the old token.</div>
    </div>
  </div>
  <div class="srow">
    <div class="slabel">Access URL<small>Open in browser</small></div>
    <div class="stoken-wrap">
      <input id="s-url" class="sinput" type="text" readonly>
      <button id="s-copy-url" class="xbtn">Copy</button>
    </div>
  </div>
</div>
<div class="block" id="s-tls" style="display:none">
  <div class="blabel">TLS Certificate</div>
  <div class="srow">
    <div class="slabel">Common name<small>Required for remote access</small></div>
    <div>
      <input id="s-cn" class="sinput sinput-warn" type="text" placeholder="e.g. MacBook-Pro.local">
      <div id="s-cn-err" class="sinput-err" style="display:none">Required to enable remote access</div>
      <div id="s-cn-note" class="sinput-note" style="display:none">Saving this replaces the certificate
        on the next start: the fingerprint below changes and any pinned client must be re-pinned.</div>
    </div>
  </div>
  <div class="srow">
    <div class="slabel">Fingerprint<small>SHA-256 — pin it on a client</small></div>
    <div class="stoken-wrap">
      <input id="s-fp" class="sinput" type="text" readonly
             placeholder="Available after restarting in remote mode">
      <button id="s-copy-fp" class="xbtn">Copy</button>
    </div>
  </div>
</div>
<div class="block">
  <div class="blabel">Notifications</div>
  <div class="srow">
    <div class="slabel">Tray notifies you when<small>The menu-bar app on this machine. Its icon is never silenced by these — it costs nothing to ignore.</small></div>
    <div class="shooks">
      <div class="shook-row"><div id="s-tray-needsYou" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A session needs you</span></div>
      <div class="shook-row"><div id="s-tray-fails" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A session fails</span></div>
      <div class="shook-row"><div id="s-tray-finishes" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A session is back to you</span></div>
      <div class="shook-row"><div id="s-tray-updates" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A new server version is out</span></div>
    </div>
  </div>
  <div class="srow">
    <div class="slabel">Where notifications go<small>The tray shows them on this machine. Nothing else is sent anywhere unless you add an endpoint below.</small></div>
    <button id="s-hook-custom" class="sdisclose" aria-expanded="false">Send to a webhook…</button>
  </div>
  <div class="srow scustom" hidden>
    <div class="slabel">Webhook URL<small>Where the POST goes. Any service that accepts one — leaving it empty keeps the webhook off.</small></div>
    <input id="s-hook-url" class="sinput" type="text" placeholder="https://example.com/hook">
  </div>
  <div class="srow scustom" hidden>
    <div class="slabel">Send when<small>Its own set: the same event can be worth a banner on the tray and not worth sending here.</small></div>
    <div class="shooks">
      <div class="shook-row"><div id="s-hook-needsYou" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A session needs you</span></div>
      <div class="shook-row"><div id="s-hook-fails" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A session fails</span></div>
      <div class="shook-row"><div id="s-hook-finishes" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A session is back to you</span></div>
      <div class="shook-row"><div id="s-hook-updates" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A new server version is out</span></div>
    </div>
  </div>
  <div class="srow scustom" hidden>
    <div class="slabel">Headers<small>Sent with every POST, one <code>Name: value</code> per line. This is where a service's auth token goes.</small></div>
    <textarea id="s-hook-headers" class="sinput" rows="2" placeholder="Authorization: Bearer …"></textarea>
  </div>
  <div class="srow scustom" hidden>
    <div class="slabel">Body template<small>What gets posted. Use {{title}}, {{body}}, {{project}}, {{subject}}, {{kind}}. Empty posts the body alone.</small></div>
    <textarea id="s-hook-template" class="sinput" rows="2" placeholder="{{title}}"></textarea>
  </div>
</div>
<div class="block">
  <div class="blabel">About</div>
  <div class="srow">
    <div class="slabel">Version<small>The server answering</small></div>
    <div id="s-version" class="sversion">—</div>
  </div>
  <div class="srow" id="s-update-row" style="display:none">
    <div class="slabel">Update<small>npm, checked once an hour</small></div>
    <div id="s-update" class="sversion supdate"></div>
  </div>
</div>
<div class="settings-save">
  <span id="s-restart" class="srestart-hint" style="display:none">${RESTART_SVG}Restart required</span>
  <span id="s-msg" class="smsg" style="display:none"></span>
  <button id="s-restart-now" class="xbtn s-restart-btn" style="display:none">Restart now</button>
  <button id="s-discard" class="xbtn">Discard</button>
  <button id="s-save" class="xbtn s-save-btn" disabled>Save</button>
</div>`;
  document.body.append(drawer);

  // ── element references ─────────────────────────────────────────────────────
  const qd = <T extends HTMLElement>(sel: string): T => drawer.querySelector<T>(sel)!;

  const dclose = qd<HTMLButtonElement>('.close');
  const banner = qd<HTMLDivElement>('#s-banner');
  const portEl = qd<HTMLInputElement>('#s-port');
  const hostEl = qd<HTMLInputElement>('#s-host');
  const openTrack = qd<HTMLDivElement>('#s-open-track');
  const openLabel = qd<HTMLSpanElement>('#s-open-label');
  const tokenEl = qd<HTMLInputElement>('#s-token');
  const regenBtn = qd<HTMLButtonElement>('#s-regen');
  const urlEl = qd<HTMLInputElement>('#s-url');
  const copyUrlBtn = qd<HTMLButtonElement>('#s-copy-url');
  const tlsSection = qd<HTMLDivElement>('#s-tls');
  const tokenNote = qd<HTMLDivElement>('#s-token-note');
  const cnEl = qd<HTMLInputElement>('#s-cn');
  const cnErr = qd<HTMLDivElement>('#s-cn-err');
  const cnNote = qd<HTMLDivElement>('#s-cn-note');
  const fpEl = qd<HTMLInputElement>('#s-fp');
  const versionEl = qd<HTMLDivElement>('#s-version');
  const updateRow = qd<HTMLDivElement>('#s-update-row');
  const updateEl = qd<HTMLDivElement>('#s-update');
  const copyFpBtn = qd<HTMLButtonElement>('#s-copy-fp');
  const restartEl = qd<HTMLSpanElement>('#s-restart');
  const msgEl = qd<HTMLSpanElement>('#s-msg');
  const restartNowBtn = qd<HTMLButtonElement>('#s-restart-now');
  const discardBtn = qd<HTMLButtonElement>('#s-discard');
  const saveBtn = qd<HTMLButtonElement>('#s-save');

  // ── helpers ────────────────────────────────────────────────────────────────
  function setOpen(on: boolean): void {
    openTrack.classList.toggle('on', on);
    openLabel.textContent = on ? 'Yes' : 'No';
  }

  /**
   * Show the About row only when there is a newer version. "You are up to date" is a row that says
   * nothing on every other day, and the panel already states which version is answering.
   */
  async function showUpdate(): Promise<void> {
    try {
      const s = (await authFetch('/api/update').then((r) => r.json())) as {
        latest?: string;
        standing?: string;
        command?: string | null;
      };
      const behind = s.standing === 'behind' && !!s.latest;
      updateRow.style.display = behind ? '' : 'none';
      // The COMMAND, not a pointer to another command: this server knows how it was installed, and
      // `seedeep update` would only have printed the same line the endpoint already carries.
      if (behind) {
        updateEl.textContent = s.command
          ? `${s.latest} available — run \`${s.command}\`, then \`seedeep restart\``
          : `${s.latest} available — replace this executable, then \`seedeep restart\``;
      }
    } catch {
      // A server too old for the endpoint, or one that could not reach npm, leaves the row hidden:
      // there is nothing to report, and an error here is not the user's problem.
      updateRow.style.display = 'none';
    }
  }

  function setDirty(d: boolean): void {
    dirty = d;
    if (!d) {
      saveBtn.disabled = true;
      return;
    }
    // A bad CN still blocks the save even when the form is dirty. Asked of `resolveFormState`
    // rather than re-derived here — that duplication is how a panel and its tests drift apart.
    saveBtn.disabled = !resolveFormState(hostEl.value, cnEl.value).canSave;
  }

  function setRestartAvailable(on: boolean): void {
    restartNowBtn.style.display = on ? '' : 'none';
  }

  function showMsg(text: string, isErr = false, durationMs = 3000): void {
    msgEl.textContent = text;
    msgEl.className = isErr ? 'smsg err' : 'smsg';
    msgEl.style.display = '';
    restartEl.style.display = 'none'; // msg and restart-hint share the same left slot
    setTimeout(() => {
      msgEl.style.display = 'none';
      updateRemote(); // re-evaluate restart hint visibility
    }, durationMs);
  }

  function computeAccessUrl(): string {
    const host = hostEl.value.trim() || '127.0.0.1';
    const port = portEl.value.trim() || '44842';
    const cn = cnEl.value.trim();
    const remote = !isLoopback(host);
    const proto = remote ? 'https' : 'http';
    const displayHost = remote ? cn || host : 'localhost';
    const base = `${proto}://${displayHost}:${port}`;
    if (!remote) return base;
    const token = pendingToken || getToken();
    return token ? `${base}/?token=${encodeURIComponent(token)}` : base;
  }

  function updateRemote(): void {
    const { remote, canSave, cnError } = resolveFormState(hostEl.value, cnEl.value);
    banner.style.display = remote ? '' : 'none';
    // Also revealed when the name is bad, even in loopback mode where TLS is not in use: the name
    // is still on its way to config.json, so it still blocks Save — and a disabled Save whose
    // reason is inside a hidden section is a dead end with no way out of the panel.
    tlsSection.style.display = remote || cnError ? '' : 'none';
    const portChanged = portEl.value !== (savedState?.port ?? '');
    const hostChanged = hostEl.value.trim() !== (savedState?.host ?? '');
    restartEl.style.display = portChanged || hostChanged ? '' : 'none';
    if (cnError) cnErr.textContent = cnError;
    cnErr.style.display = cnError ? '' : 'none';
    // Only when a name that ALREADY produced a certificate is being changed: on first setup
    // nothing is replaced, and a warning that fires when it does not apply is one the user learns
    // to ignore before it ever matters.
    const replacing = remote && !!savedState?.cn && !cnError && cnEl.value.trim() !== savedState.cn;
    cnNote.style.display = replacing ? '' : 'none';
    saveBtn.disabled = !canSave || !dirty;
    urlEl.value = computeAccessUrl();
  }

  // ── load ───────────────────────────────────────────────────────────────────
  const hookUrlEl = drawer.querySelector<HTMLInputElement>('#s-hook-url')!;
  const hookHeadersEl = drawer.querySelector<HTMLTextAreaElement>('#s-hook-headers')!;
  const hookTemplateEl = drawer.querySelector<HTMLTextAreaElement>('#s-hook-template')!;
  const traySwitches = {
    needsYou: drawer.querySelector<HTMLDivElement>('#s-tray-needsYou')!,
    fails: drawer.querySelector<HTMLDivElement>('#s-tray-fails')!,
    finishes: drawer.querySelector<HTMLDivElement>('#s-tray-finishes')!,
    updates: drawer.querySelector<HTMLDivElement>('#s-tray-updates')!,
  };
  const hookSwitches = {
    needsYou: drawer.querySelector<HTMLDivElement>('#s-hook-needsYou')!,
    fails: drawer.querySelector<HTMLDivElement>('#s-hook-fails')!,
    finishes: drawer.querySelector<HTMLDivElement>('#s-hook-finishes')!,
    updates: drawer.querySelector<HTMLDivElement>('#s-hook-updates')!,
  };
  // The same control the rest of the drawer uses; `on` IS the state, as it is for Open browser.
  //
  // Concatenated, never spread into one object: the two channels carry the SAME four keys, so
  // `{ ...tray, ...hook }` silently keeps four entries out of eight and leaves one channel's
  // toggles with no listener at all — which is exactly what it did.
  for (const track of [...Object.values(traySwitches), ...Object.values(hookSwitches)]) {
    track.parentElement?.addEventListener('click', () => {
      track.classList.toggle('on');
      setDirty(true);
    });
  }

  const customBtn = drawer.querySelector<HTMLButtonElement>('#s-hook-custom')!;
  const customRows = [...drawer.querySelectorAll<HTMLElement>('.scustom')];
  customBtn.addEventListener('click', () => {
    const open = customBtn.getAttribute('aria-expanded') === 'true';
    customBtn.setAttribute('aria-expanded', String(!open));
    customBtn.textContent = open ? 'Send to a webhook…' : 'Hide webhook settings';
    for (const row of customRows) row.hidden = open;
  });

  /** The webhook fields as a request body's worth of form state. */
  /** The tray channel's four switches, read off the toggles. */
  const trayForm = () => ({
    needsYou: traySwitches.needsYou.classList.contains('on'),
    fails: traySwitches.fails.classList.contains('on'),
    finishes: traySwitches.finishes.classList.contains('on'),
    updates: traySwitches.updates.classList.contains('on'),
  });

  const webhookForm = (): WebhookForm => ({
    url: hookUrlEl.value.trim(),
    headersText: hookHeadersEl.value,
    template: hookTemplateEl.value,
    needsYou: hookSwitches.needsYou.classList.contains('on'),
    fails: hookSwitches.fails.classList.contains('on'),
    finishes: hookSwitches.finishes.classList.contains('on'),
    updates: hookSwitches.updates.classList.contains('on'),
  });

  async function load(): Promise<void> {
    try {
      const cfg = (await authFetch('/api/config').then((r) => r.json())) as ConfigResponse;
      savedState = {
        port: String(cfg.port ?? 44842),
        host: cfg.host ?? '127.0.0.1',
        open: cfg.open ?? true,
        cn: cfg.tls?.commonName ?? '',
      };
      portEl.value = savedState.port;
      hostEl.value = savedState.host;
      setOpen(savedState.open);
      cnEl.value = savedState.cn;
      // Server state, not a form field: it describes the certificate this process is serving,
      // so Discard must not revert it and a Save cannot change it (a new cert needs a restart).
      // Empty leaves the placeholder visible, which is the honest answer while there is none.
      fpEl.value = cfg.tls?.fingerprint ?? '';
      const tray = cfg.notifications?.tray;
      traySwitches.needsYou.classList.toggle('on', tray?.needsYou ?? true);
      traySwitches.fails.classList.toggle('on', tray?.fails ?? true);
      traySwitches.finishes.classList.toggle('on', tray?.finishes ?? false);
      traySwitches.updates.classList.toggle('on', tray?.updates ?? true);
      const hook = cfg.notifications?.webhook;
      hookUrlEl.value = hook?.url ?? '';
      // Values arrive redacted (`***`) because this endpoint answers without auth. Showing them is
      // deliberate: the user sees WHICH headers exist, and posting `***` back is what the server
      // reads as "keep the one you have" — a blank field would erase the token on the next Save.
      hookHeadersEl.value = formatHeaders(hook?.headers ?? {});
      hookTemplateEl.value = hook?.template ?? '';
      hookSwitches.needsYou.classList.toggle('on', hook?.needsYou ?? true);
      hookSwitches.fails.classList.toggle('on', hook?.fails ?? true);
      hookSwitches.finishes.classList.toggle('on', hook?.finishes ?? false);
      hookSwitches.updates.classList.toggle('on', hook?.updates ?? false);
      // The dash stays when the field is absent: a server too old to report its version is a
      // question this panel cannot answer, and a guess here would be the one number a bug report
      // quotes verbatim.
      versionEl.textContent = cfg.version ?? '—';
      void showUpdate();
      // Token is always redacted from the server; reset any pending regen.
      pendingToken = '';
      tokenEl.value = '***';
      tokenEl.type = 'password';
      tokenNote.style.display = 'none';
      setRestartAvailable(false);
      updateRemote(); // also calls computeAccessUrl via urlEl.value update
      setDirty(false);
    } catch {
      showMsg('Could not load config', true);
    }
  }

  // ── open / close ───────────────────────────────────────────────────────────
  function open(): void {
    btn.classList.add('active');
    scrim.classList.add('on');
    drawer.classList.add('on');
    void load();
  }

  function close(): void {
    btn.classList.remove('active');
    scrim.classList.remove('on');
    drawer.classList.remove('on');
  }

  btn.addEventListener('click', () => (drawer.classList.contains('on') ? close() : open()));
  scrim.addEventListener('click', close);
  dclose.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('on')) close();
  });

  // ── field interactions ─────────────────────────────────────────────────────
  portEl.addEventListener('input', () => {
    setDirty(true);
    updateRemote();
  });
  hostEl.addEventListener('input', () => {
    setDirty(true);
    updateRemote();
  });
  openTrack.addEventListener('click', () => {
    openTrack.classList.toggle('on');
    openLabel.textContent = openTrack.classList.contains('on') ? 'Yes' : 'No';
    setDirty(true);
  });
  cnEl.addEventListener('input', () => {
    setDirty(true);
    updateRemote();
  });

  regenBtn.addEventListener('click', () => {
    pendingToken = randomToken();
    tokenEl.value = pendingToken;
    // Reveal the new token so the user can note it before saving.
    tokenEl.type = 'text';
    // Shown only while a new token is pending: rotating it is the panel's other action that
    // breaks a client on a different machine, and nothing else here said so.
    tokenNote.style.display = '';
    setDirty(true);
    urlEl.value = computeAccessUrl();
  });

  /** Copy an input's value to the clipboard and flash the button. No value → no-op, so the
   * fingerprint's Copy does nothing while the server has no certificate to report. */
  function wireCopy(btn: HTMLButtonElement, input: HTMLInputElement): void {
    btn.addEventListener('click', () => {
      if (!input.value) return;
      navigator.clipboard?.writeText(input.value).catch(() => {
        /* non-fatal */
      });
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1800);
    });
  }
  wireCopy(copyUrlBtn, urlEl);
  wireCopy(copyFpBtn, fpEl);

  discardBtn.addEventListener('click', () => {
    if (!savedState) return;
    portEl.value = savedState.port;
    hostEl.value = savedState.host;
    setOpen(savedState.open);
    cnEl.value = savedState.cn;
    pendingToken = '';
    tokenEl.value = '***';
    tokenEl.type = 'password';
    tokenNote.style.display = 'none';
    cnErr.style.display = 'none';
    updateRemote(); // also recomputes URL
    setDirty(false);
  });

  saveBtn.addEventListener('click', async () => {
    const host = hostEl.value.trim();
    if (!resolveFormState(host, cnEl.value).canSave) {
      updateRemote(); // shows the reason under the field
      cnEl.focus();
      return;
    }
    saveBtn.disabled = true;
    const body = buildSaveBody(
      Number(portEl.value),
      host,
      openTrack.classList.contains('on'),
      cnEl.value,
      pendingToken,
      webhookForm(),
      trayForm(),
    );

    try {
      const res = await authFetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const r = (await res.json()) as ConfigResponse & { error?: string };
      // A rejection used to be parsed as a config and reported as "Saved" — the panel said the
      // opposite of what happened, and the value the user typed was never stored.
      if (!res.ok) {
        showMsg(r.error ?? 'Save failed', true, 6000);
        saveBtn.disabled = false;
        return;
      }

      savedState = {
        port: String(r.port ?? body['port']),
        host: (r.host as string) ?? host,
        open: (r.open as boolean) ?? openTrack.classList.contains('on'),
        cn: (r.tls as { commonName?: string } | undefined)?.commonName ?? cnEl.value.trim(),
      };
      // Sync localStorage so authFetch keeps working after the server adopts the new token.
      if (pendingToken) setToken(pendingToken);
      pendingToken = '';
      tokenEl.value = '***';
      tokenEl.type = 'password';
      tokenNote.style.display = 'none'; // the lockout has happened; warning about it is now noise

      updateRemote(); // also recomputes URL via computeAccessUrl → getToken
      setDirty(false);
      if (r.restart_required) {
        setRestartAvailable(true);
        showMsg('Saved — restart to apply');
      } else {
        showMsg('Saved');
      }
    } catch {
      showMsg('Save failed', true);
      saveBtn.disabled = false;
    }
  });

  restartNowBtn.addEventListener('click', async () => {
    restartNowBtn.disabled = true;
    restartNowBtn.textContent = 'Restarting…';
    try {
      await authFetch('/api/restart', { method: 'POST' });
    } catch {
      // Expected: the server exits before the response is fully flushed.
    }
    restartNowBtn.style.display = 'none';
    restartEl.style.display = 'none';
    // The spawned child needs a moment to bind the port before we reload.
    // Poll until the server is back (max 10 s), then reload the page.
    msgEl.textContent = 'Restarting…';
    msgEl.className = 'smsg';
    msgEl.style.display = '';
    const deadline = Date.now() + 10_000;
    const poll = async (): Promise<void> => {
      try {
        const r = await authFetch('/api/config');
        if (r.ok) {
          window.location.reload();
          return;
        }
      } catch {
        /* not up yet */
      }
      if (Date.now() < deadline) setTimeout(poll, 400);
      else {
        msgEl.textContent = 'Server did not come back — check the terminal';
        msgEl.className = 'smsg err';
      }
    };
    setTimeout(poll, 600);
  });
}
