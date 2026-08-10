import type { NotifyConfig } from './config.ts';
import type { DigestEntry } from './digest.ts';
import { type Announcement, createNotifyWatch } from './notify-watch.ts';

/** Where one announcement is sent. */
export type NotifyChannel = 'tray' | 'webhook';

export interface NotifyEngineDeps {
  /** Read fresh every time: the panel can rewrite the switches between two readings. */
  config: () => NotifyConfig;
  /** Send one announcement on one channel. May throw; the engine absorbs it. */
  deliver: (a: Announcement, channel: NotifyChannel) => void;
  /**
   * Whether any client is subscribed to the stream the tray channel is delivered on.
   * Defaults to "yes" so a caller that does not track subscribers keeps the tray working.
   */
  hasListeners?: () => boolean;
}

export interface NotifyEngine {
  /** Fold one reading in and deliver what it produced. `null` = a reading that could not be made. */
  feed(entries: DigestEntry[] | null): void;
  /**
   * Whether evaluating at all is worth doing right now.
   *
   * The tray is worth evaluating only while a client is subscribed — a closed tray has nobody to
   * deliver to, and an open one is already asking for the digest on its own clock. A configured
   * webhook always is, because its destination is not on this machine. This is what keeps a process
   * nobody is watching idle: with the webhook off, the answer is no and no tree is kept alive.
   */
  wanted(): boolean;
}

/**
 * Decide what is an event and hand it to the channels that asked for it.
 *
 * The switches filter the OUTPUT of the detector and never its input: the transitions are tracked
 * whatever they say, so turning one back on announces what happens next, not the backlog. That is
 * the one rule here that cannot be optimised away — skipping `step()` when every switch is off
 * would reintroduce exactly the replay it exists to prevent.
 */
export function createNotifyEngine(deps: NotifyEngineDeps): NotifyEngine {
  const watch = createNotifyWatch();
  const listening = deps.hasListeners ?? (() => true);
  return {
    wanted() {
      return listening() || deps.config().webhook.url !== '';
    },
    feed(entries) {
      const cfg = deps.config();
      // Unconditional: see the note above. The gate is below, per announcement.
      for (const a of watch.step(entries)) {
        if (cfg.tray[a.kind]) send(deps, a, 'tray');
        // An unconfigured webhook is an absent channel, whatever its switches say.
        if (cfg.webhook.url !== '' && cfg.webhook[a.kind]) send(deps, a, 'webhook');
      }
    },
  };
}

/**
 * Deliver one announcement, absorbing a failure.
 *
 * A user's broken webhook URL must not take down the tray's banner, nor the loop that recorded the
 * transition — otherwise one bad setting turns every later event into a missed one.
 */
function send(deps: NotifyEngineDeps, a: Announcement, channel: NotifyChannel): void {
  try {
    deps.deliver(a, channel);
  } catch (err) {
    console.error(`seedeep: ${channel} notification failed —`, err);
  }
}
