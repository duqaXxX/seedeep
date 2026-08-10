//! The menu-bar icon, DRAWN rather than shipped as image files.
//!
//! Exported assets would be one file per state per size, all re-cut by hand whenever the mark
//! changes, and none of which a test can say anything about. Drawing them from one geometry
//! keeps a single source of truth and makes the states assertable —
//! `icon_states_are_distinguishable` is the test that an asset pipeline cannot have.
//!
//! Two facts fix the numbers below. macOS scales the tray image to **18 points tall** whatever
//! the buffer contains (tray-icon `platform_impl/macos`), so the buffer's HEIGHT is the mark's
//! entire size budget and every empty row shrinks it. And the states are told apart by SHAPE
//! wherever they can be — a slash, a hollow iris, a filled one, a cross — rather than by colour
//! alone. The one pair that shares a shape is working-vs-waiting, and it is blue against amber:
//! the pair that survives the common colour-vision deficiencies best.

use tauri::image::Image;

/// The tray icon's id. Named once because two places have to agree on it: the builder that creates
/// the icon, and the poll that repaints it from each reading.
pub const TRAY_ID: &str = "seedeep";

/// The buffer, cropped to the ink on BOTH axes. Because macOS fits the height to 18 pt, a square
/// buffer around a mark wider than tall left the eye filling 55% of the height — drawn at ~10 pt
/// in an 18 pt slot, visibly lighter than every neighbouring icon.
///
/// Width is the other half of the same fact: height is fitted, so width is whatever the mark's
/// proportions make it, and an elongated eye simply takes more of the menu bar than its
/// neighbours. The lens is now 1.38 wide for 1 tall rather than 1.77, which with the badge and
/// the slash included brings the whole buffer from 36×26 to 27×26 — a quarter narrower, and still
/// an eye. Rounder was tried and rejected: past about 1.2 the mark reads as a target, and the eye
/// is what the name means.
const W: u32 = 27;
const H: u32 = 26;

/// The mark is designed in the unit square; these map the buffer onto the slice of that square
/// which carries ink, so only the framing moved. The window has to hold every state at once — the
/// eye, the badge above its upper right, and the slash, which reaches furthest of the three.
/// DERIVED from the geometry below rather than guessed: change `EYE_A`/`EYE_B` and these four
/// numbers are what has to be recomputed, or the mark grows transparent margins that shrink it.
const COL_LEFT: f64 = 0.097;
const COLS: f64 = 0.834;
const BAND_TOP: f64 = 0.012;
const BAND: f64 = 0.803;

/// Supersampling factor per axis. 4 gives 16 samples a pixel — enough for a curve this small.
const SS: u32 = 4;

/// The eye's lens is the intersection of two circles. Given the half-width `a` and half-height
/// `b` we want, their offset and radius are forced: `a² = 2bd + b²`, `R = d + b`.
const EYE_A: f64 = 0.40;
const EYE_B: f64 = 0.29;
const EYE_D: f64 = (EYE_A * EYE_A - EYE_B * EYE_B) / (2.0 * EYE_B);
const EYE_R: f64 = EYE_D + EYE_B;
/// Outline thickness, as an inward offset of both arcs — which is why it is subtracted from the
/// radius rather than scaling the whole lens (scaling would thin the outline at the corners).
const STROKE: f64 = 0.075;

const IRIS_R: f64 = 0.185;
const IRIS_INNER: f64 = 0.115;
const PUPIL_R: f64 = 0.075;

/// The broken eye's cross: how far an arm reaches from the centre, and its half-thickness.
///
/// Sized against the IRIS rather than the lens, because the mark has to sit exactly where every
/// other state puts its iris or the eye stops being the same eye: an arm's end is 0.177 from the
/// centre, inside `IRIS_R`. The stroke comes out ~2.9 px in the buffer — the thinnest ink this
/// mark carries, and the reason it is not thinner is that at 18 pt a hairline greys out instead
/// of reading as a line.
const CROSS_ARM: f64 = 0.125;
const CROSS_STROKE: f64 = 0.045;

/// The slice missing from the working iris, as a fraction of a full turn. A radar wedge: the iris
/// is filled, and what moves is the 90° hole cut out of it.
///
/// The motion replaces the IRIS and never the outline, which is what lets the mark stay an eye and
/// stay exactly the same size while it spins — the rule `the_eye_is_the_same_size_in_every_state`
/// enforces, now across every frame. Three lighter candidates were rendered at 18 pt and rejected
/// against this one (a travelling arc, a running gap, an expanding ping): at this size the amount of
/// ink in motion IS the signal, and the wedge moves the most of it.
const WEDGE: f64 = 0.25;

/// Frames in one turn of the wedge, and how fast they are shown — 24 steps of 15°, one turn every
/// two seconds.
///
/// **The rate is what it costs**, and the cost is the platform's rather than ours: the frames are
/// rasterised once, and each one is a `set_icon`, which on macOS redraws the menu bar item.
/// Measured on the bundled app, panel closed, one session working, as 30 s samples of process CPU
/// time: **24 fps = 10.9% of one core (one sample), 12 fps = 7.3% (7.3 / 7.3 / 7.7 over three),
/// nothing working = 0.3%**. 12 is Davide's call, made on those numbers.
///
/// Note what the pair says: HALVING the rate did not halve the cost. Something under `set_icon` is
/// paid per repaint and something is paid per second regardless, so buying smoothness back is
/// cheaper than the first measurement suggested — and any further cut has less and less to win.
///
/// The frame COUNT stays 24 at the lower rate, so the wedge still moves 15° a step and takes two
/// seconds a turn. Halving the frames instead would keep the turn at a second and step 30°, which
/// is where a spinner starts to read as a stutter — and a spinner is judged out of the corner of
/// the eye, on whether the motion is smooth.
pub const SPIN_FRAMES: u32 = 24;
pub const SPIN_FPS: u32 = 12;

/// Transparent gap around the slash. Without it the slash merges into the eye's outline at
/// 18 pt and the icon turns into a blob.
const MOAT: f64 = 0.05;

/// Whether THIS BUILD is a checkout being developed — defined once, in `local.rs`, because the
/// connection screen needs the same fact to word its "nothing to start" message.
use crate::local::DEV_BUILD;

/// The development mark: a small disc in the corner the badge does not use.
///
/// Mirrored from {@link BADGE_C} and deliberately SMALLER than it, so the two are told apart at
/// 18 pt by size as well as by side — the badge means "more than one session is waiting" and
/// changes while you watch, this one never changes at all. The corner is free space: the eye
/// reaches y≈0.36 at that x, so a disc ending at 0.25 keeps its daylight, and the eye does not
/// shrink to make room. Every state carries it, because what it marks is the BUILD.
const DEV_C: (f64, f64) = (0.210, 0.151);
const DEV_R: f64 = 0.095;

/// The badge, in the same unit-square coordinates as the eye. It sits above the eye's
/// upper-right, inside the band and clear of the outline — the eye reaches y≈0.36 at that x, so
/// a disc ending at 0.32 keeps about a pixel of daylight. Two rejected placements are why those
/// numbers are what they are: a badge given a corner of its own forced the eye to shrink, and a
/// badge low enough to touch the outline merged with it and read as a deformity rather than a
/// count. **The eye's size does not change when the badge appears** — that is the point.
const BADGE_C: (f64, f64) = (0.790, 0.151);
const BADGE_R: f64 = 0.139;

/// What the icon says. `Waiting` carries the count, but only to decide whether the badge is
/// drawn — see `badge`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TrayState {
    /// Nothing is answering at the configured address — the tray says so rather than showing
    /// an idle icon it cannot vouch for.
    Unreachable,
    /// Reachable, no live session.
    Idle,
    /// At least one session working, none waiting.
    Working,
    /// `count` sessions stopped on an approval.
    Waiting { count: usize },
    /// `count` sessions whose last model call FAILED — an API error nothing has recovered from.
    /// Outranks every other state: a session stopped on you is healthy and will resume the moment
    /// you answer, while a failed one has stopped and will not restart by itself (measured over
    /// 1830 real transcripts: 39 of 47 errors were the last model line their session ever wrote).
    Failed { count: usize },
}

impl TrayState {
    /// The icon's single colour. Mid-tones on purpose: seedeep's own sky-300 and the portal's
    /// amber are chosen against a dark page, and would wash out on a light menu bar.
    fn rgb(self) -> [u8; 3] {
        match self {
            // The disconnected state is not an error colour: the tray is not broken, it is
            // telling you it cannot see anything.
            TrayState::Unreachable | TrayState::Idle => [0x94, 0xa3, 0xb8],
            TrayState::Working => [0x0e, 0xa5, 0xe9],
            TrayState::Waiting { .. } => [0xf5, 0x9e, 0x0b],
            // Red, and the same mid-tone reasoning as the amber above: the portal's --crit
            // (#fb7185) is picked against a dark page and would wash out on a light menu bar.
            TrayState::Failed { .. } => [0xdc, 0x26, 0x26],
        }
    }

    /// Whether the badge is drawn — above one waiting session, never at one.
    ///
    /// It says THAT there is more than one, not how many. A numeral was built and rendered
    /// first: at 18 pt a digit is three pixels wide and a `3` comes out a smudge, and the only
    /// way to give it room is to shrink the eye until the primary signal is the thing that
    /// suffers. The exact count is one click away in the panel, which is where this app sends
    /// you for anything it cannot say at a glance.
    fn badge(self) -> bool {
        matches!(
            self,
            TrayState::Waiting { count } | TrayState::Failed { count } if count > 1
        )
    }
}

fn in_disc(x: f64, y: f64, c: (f64, f64), r: f64) -> bool {
    let (dx, dy) = (x - c.0, y - c.1);
    dx * dx + dy * dy <= r * r
}

/// Inside the lens formed by the two circles, inset by `shrink`.
fn in_lens(x: f64, y: f64, shrink: f64) -> bool {
    let r = EYE_R - shrink;
    r > 0.0 && in_disc(x, y, (0.5, 0.5 + EYE_D), r) && in_disc(x, y, (0.5, 0.5 - EYE_D), r)
}

/// Distance from the point to a SEGMENT rather than to the line through it, so a stroke stops at
/// its endpoints instead of running off the buffer.
fn seg_distance(x: f64, y: f64, a: (f64, f64), b: (f64, f64)) -> f64 {
    let (vx, vy) = (b.0 - a.0, b.1 - a.1);
    let t = (((x - a.0) * vx + (y - a.1) * vy) / (vx * vx + vy * vy)).clamp(0.0, 1.0);
    ((x - (a.0 + t * vx)).powi(2) + (y - (a.1 + t * vy)).powi(2)).sqrt()
}

/// Distance from the point to the icon's diagonal slash.
fn slash_distance(x: f64, y: f64) -> f64 {
    // Proportional to the lens rather than fixed points on the square: the endpoints are what
    // decide how far the slash overshoots, and a pair written for one set of eye proportions
    // silently pokes out of a different one — extending the ink box, which is the mark's whole
    // size budget. Slightly past the lens on both ends is intended; far past it is not.
    seg_distance(
        x,
        y,
        (0.5 - EYE_A * 0.55, 0.5 + EYE_B * 0.96),
        (0.5 + EYE_A * 0.55, 0.5 - EYE_B * 0.96),
    )
}

/// Where a point sits round the iris, as a fraction of a turn — 0 at 3 o'clock, growing clockwise
/// (y grows downward in the buffer).
fn turn_at(x: f64, y: f64) -> f64 {
    ((y - 0.5).atan2(x - 0.5) / std::f64::consts::TAU).rem_euclid(1.0)
}

/// How far `at` is ahead of `from`, clockwise, in turns.
fn ahead(at: f64, from: f64) -> f64 {
    (at - from).rem_euclid(1.0)
}

/// Is this point painted? Every layer is either the state's one colour or nothing, so coverage
/// is a boolean and the antialiasing below is a plain average — no per-layer compositing.
///
/// `phase` places the working wedge: 0.0 ≤ phase < 1.0, one full turn. Every other state ignores
/// it — nothing else in this mark moves.
fn is_ink(state: TrayState, phase: f64, x: f64, y: f64, dev: bool) -> bool {
    if state.badge() && in_disc(x, y, BADGE_C, BADGE_R) {
        return true;
    }

    if dev && in_disc(x, y, DEV_C, DEV_R) {
        return true;
    }

    if state == TrayState::Unreachable {
        let d = slash_distance(x, y);
        if d <= STROKE / 2.0 {
            return true;
        }
        if d <= STROKE / 2.0 + MOAT {
            return false;
        }
    }

    // Outline: inside the lens but outside the lens inset by the stroke width.
    if in_lens(x, y, 0.0) && !in_lens(x, y, STROKE) {
        return true;
    }

    match state {
        // A blind eye: no iris at all, so "unreachable" is not merely a dimmer "idle".
        TrayState::Unreachable => false,
        // Open but inactive — a ring, not a disc.
        TrayState::Idle => in_disc(x, y, (0.5, 0.5), IRIS_R) && !in_disc(x, y, (0.5, 0.5), IRIS_INNER),
        // A radar: the iris filled from the pupil out, less the wedge that is turning. The pupil
        // stays a hole so the mark is still an eye at every phase — and a hole rather than a dark
        // dot, because the menu bar behind it may be light or dark.
        TrayState::Working => {
            let r = ((x - 0.5).powi(2) + (y - 0.5).powi(2)).sqrt();
            r <= IRIS_R && r > PUPIL_R && ahead(turn_at(x, y), phase) > WEDGE
        }
        // Stopped on the user: a filled iris, and STILL. The stillness is half the message — the
        // motion means "working, leave it alone", so a waiting icon that also span would say both.
        TrayState::Waiting { .. } => {
            in_disc(x, y, (0.5, 0.5), IRIS_R) && !in_disc(x, y, (0.5, 0.5), PUPIL_R)
        }
        // Dead: a cross where every other state puts an iris. Until it had a mark of its own this
        // was waiting's geometry in red — the one pair told apart by colour alone, and the pair a
        // red-green deficiency reads worst, on the state that matters most. Three others were
        // rendered at 18 pt beside this one and rejected: a broken outline and a fractured iris
        // both read as a rendering fault rather than as information, and an exclamation lost on
        // MEANING rather than legibility — "!" says look at me, which is exactly what the amber
        // already says, while a cross says the session is not coming back.
        TrayState::Failed { .. } => {
            let arm = |a: (f64, f64), b: (f64, f64)| seg_distance(x, y, a, b) <= CROSS_STROKE;
            arm(
                (0.5 - CROSS_ARM, 0.5 - CROSS_ARM),
                (0.5 + CROSS_ARM, 0.5 + CROSS_ARM),
            ) || arm(
                (0.5 - CROSS_ARM, 0.5 + CROSS_ARM),
                (0.5 + CROSS_ARM, 0.5 - CROSS_ARM),
            )
        }
    }
}

/// Render one state as a non-premultiplied RGBA buffer, `W`×`H`, at one phase of the working
/// wedge — see {@link is_ink}. Every state but `Working` renders identically at every phase.
pub fn render_at(state: TrayState, phase: f64) -> Vec<u8> {
    render_with(state, phase, DEV_BUILD)
}

/// The same, with the development mark decided by the CALLER rather than by how this binary was
/// built.
///
/// It exists for the tests, and that is not a convenience. `DEV_BUILD` is `tauri::is_dev()`, which
/// is `!cfg!(feature = "custom-protocol")` — a feature only `tauri build` turns on — so under
/// `cargo test` it is `true` and every rendered icon carries the dot. The geometry rules are about
/// the icon a user's menu bar shows, so they have to be able to ask for that one.
fn render_with(state: TrayState, phase: f64, dev: bool) -> Vec<u8> {
    let [r, g, b] = state.rgb();
    let mut out = Vec::with_capacity((W * H * 4) as usize);
    for py in 0..H {
        for px in 0..W {
            let mut hits = 0u32;
            for sy in 0..SS {
                for sx in 0..SS {
                    let x = COL_LEFT
                        + (px as f64 + (sx as f64 + 0.5) / SS as f64) / W as f64 * COLS;
                    let y = BAND_TOP
                        + (py as f64 + (sy as f64 + 0.5) / SS as f64) / H as f64 * BAND;
                    if is_ink(state, phase, x, y, dev) {
                        hits += 1;
                    }
                }
            }
            out.extend_from_slice(&[r, g, b, (hits * 255 / (SS * SS)) as u8]);
        }
    }
    out
}

/// Render a state that does not move.
pub fn render(state: TrayState) -> Vec<u8> {
    render_at(state, 0.0)
}

/// The state's icon, ready for `TrayIcon::set_icon`.
pub fn image(state: TrayState) -> Image<'static> {
    Image::new_owned(render(state), W, H)
}

/// One full turn of the working wedge, in order.
///
/// Rendered ONCE and handed to the poll to cycle: the alternative is rasterising the mark `SPIN_FPS`
/// times a second forever, and the whole turn is 24 × 2.8 KB — a rounding error in memory against
/// work that would otherwise never stop.
pub fn spin() -> Vec<Image<'static>> {
    (0..SPIN_FRAMES)
        .map(|i| {
            let phase = f64::from(i) / f64::from(SPIN_FRAMES);
            Image::new_owned(render_at(TrayState::Working, phase), W, H)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [TrayState; 7] = [
        TrayState::Unreachable,
        TrayState::Idle,
        TrayState::Working,
        TrayState::Waiting { count: 1 },
        TrayState::Waiting { count: 3 },
        TrayState::Failed { count: 1 },
        TrayState::Failed { count: 3 },
    ];

    /// Every frame of the working spin, as raw buffers — what the menu bar actually cycles through.
    fn spin_frames() -> Vec<Vec<u8>> {
        (0..SPIN_FRAMES)
            .map(|i| render_at(TrayState::Working, f64::from(i) / f64::from(SPIN_FRAMES)))
            .collect()
    }

    /// The RELEASED icon: what a user's menu bar shows, which is what every geometry rule is about.
    ///
    /// `render` cannot answer that question here. `DEV_BUILD` is `tauri::is_dev()`, and the CLI
    /// passes `--features tauri/custom-protocol` only on `tauri build` — so under `cargo test` the
    /// dot is on, and a rule measuring the eye's left edge was measuring the dot instead.
    fn shipped(state: TrayState) -> Vec<u8> {
        render_with(state, 0.0, false)
    }

    /// The released icon across the whole spin — see {@link shipped}.
    fn shipped_spin() -> Vec<Vec<u8>> {
        (0..SPIN_FRAMES)
            .map(|i| render_with(TrayState::Working, f64::from(i) / f64::from(SPIN_FRAMES), false))
            .collect()
    }

    /// Throwaway review aid: dumps every state, with and without the development mark, so the two
    /// can be LOOKED at rather than described. Not a check — it asserts nothing.
    #[test]
    #[ignore = "review aid: SEEDEEP_ICON_DUMP=<dir> cargo test -- --ignored dump_icons"]
    fn dump_icons() {
        let Some(dir) = std::env::var_os("SEEDEEP_ICON_DUMP") else { return };
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        let states = [
            ("unreachable", TrayState::Unreachable),
            ("idle", TrayState::Idle),
            ("working", TrayState::Working),
            ("waiting", TrayState::Waiting { count: 1 }),
            ("waiting2", TrayState::Waiting { count: 3 }),
            ("failed", TrayState::Failed { count: 1 }),
        ];
        for (name, state) in states {
            for dev in [false, true] {
                let suffix = if dev { "dev" } else { "prod" };
                let buf = render_with(state, 0.0, dev);
                std::fs::write(dir.join(format!("{name}-{suffix}.rgba")), buf).unwrap();
            }
        }
        println!("W={W} H={H} written to {}", dir.display());
    }

    /// "The icon is never absent" (`docs/tray.md`) is only true if every state actually paints
    /// something — a state that renders fully transparent is indistinguishable from a crash,
    /// which is the exact failure the rule exists to prevent. Working is now 24 icons rather than
    /// one, and the rule is about what is ON SCREEN: a single blank frame is a flicker.
    #[test]
    fn every_state_paints_something() {
        for state in ALL {
            let opaque = render(state).chunks(4).filter(|p| p[3] > 200).count();
            assert!(opaque > 20, "{state:?} rendered all but empty: {opaque} solid pixels");
        }
        for (i, frame) in spin_frames().iter().enumerate() {
            let opaque = frame.chunks(4).filter(|p| p[3] > 200).count();
            assert!(opaque > 20, "working frame {i} rendered all but empty: {opaque} solid pixels");
        }
    }

    /// The spin is a spin: no two frames of the turn are the same image, so the wedge really does
    /// move on every repaint. A wedge that stepped only every other frame would still look animated
    /// in a still render and cost the same repaints a second for half the motion.
    #[test]
    fn the_working_wedge_moves_on_every_frame() {
        let frames = spin_frames();

        for (i, a) in frames.iter().enumerate() {
            for (j, b) in frames.iter().enumerate().skip(i + 1) {
                assert_ne!(a, b, "working frames {i} and {j} are the same image");
            }
        }
    }

    /// The mark the poll paints for a still state is a frame of the same geometry — `render` is
    /// `render_at(_, 0.0)`, and `spin()` starts there. Asserted so the two entry points cannot
    /// drift into rendering two different eyes.
    #[test]
    fn the_still_working_icon_is_the_first_frame_of_the_spin() {
        assert_eq!(render(TrayState::Working), spin_frames()[0]);
    }

    /// A state the user cannot tell from another one carries no information. Pairwise, because
    /// it is the pair that has to differ, not the set.
    #[test]
    fn icon_states_are_distinguishable() {
        for (i, a) in ALL.iter().enumerate() {
            for b in &ALL[i + 1..] {
                assert_ne!(render(*a), render(*b), "{a:?} and {b:?} render identically");
            }
        }
    }

    /// The badge appears only above one — a mark meaning "one" is noise, since amber already
    /// says somebody is waiting.
    #[test]
    fn a_single_waiting_session_has_no_badge() {
        assert!(!TrayState::Waiting { count: 1 }.badge());
        assert!(TrayState::Waiting { count: 2 }.badge());
        // The same rule, not a second one: a badge that appeared for three approvals and not for
        // three failures would be the mark meaning two different things.
        assert!(!TrayState::Failed { count: 1 }.badge());
        assert!(TrayState::Failed { count: 2 }.badge());
    }

    /// Broken and Needs-you must differ by SHAPE, not only by colour — they are the pair a user is
    /// most likely to confuse, and red-against-amber is the pair a red-green deficiency reads
    /// worst. `icon_states_are_distinguishable` cannot carry this: it compares whole buffers, so
    /// the two colours alone are enough to pass it, which is exactly how the shared geometry went
    /// unnoticed for as long as it did. This one ignores the colour entirely and looks at the ink.
    #[test]
    fn a_failed_icon_differs_from_a_waiting_one_by_its_shape() {
        let lit = |b: &[u8]| b.chunks(4).map(|p| p[3]).collect::<Vec<_>>();
        let failed = lit(&render(TrayState::Failed { count: 1 }));
        let waiting = lit(&render(TrayState::Waiting { count: 1 }));
        // Not merely `!=`: a mark differing in a handful of pixels differs on paper and nowhere a
        // menu bar can show it. The cross replaces the whole iris, so the gap is a large fraction
        // of the ink either of them carries.
        let apart = failed.iter().zip(&waiting).filter(|(a, b)| a.abs_diff(**b) > 8).count();
        let ink = failed.iter().filter(|a| **a > 8).count();
        assert!(apart * 4 > ink, "only {apart} pixels differ, against {ink} of ink — too close to see");
    }

    /// The badge says THAT there is more than one, never how many. Asserted as equality so the
    /// day someone tries to render the count into the icon again, this test is what objects —
    /// and sends them to read why a numeral does not fit at 18 pt.
    #[test]
    fn the_badge_does_not_count() {
        let two = render(TrayState::Waiting { count: 2 });
        assert_eq!(two, render(TrayState::Waiting { count: 3 }));
        assert_eq!(two, render(TrayState::Waiting { count: 99 }));
        assert_ne!(two, render(TrayState::Waiting { count: 1 }));
    }

    /// The mark must not change size when the state changes. Framing the icon in a square buffer
    /// produced exactly that: the badge needed room, so the eye shrank to make it, and a mark
    /// that resizes as it changes meaning reads as a glitch rather than as information.
    ///
    /// Measured in the columns where ONLY the lens can put ink — left of both the badge and the
    /// slash's cap. Derived from the geometry rather than written as a number: the previous
    /// version hard-coded a column that stopped excluding the slash the moment the eye's
    /// proportions changed, and failed for the right reason with the wrong explanation.
    ///
    /// Rendered through {@link shipped}, never `render`: those same columns are where the
    /// development dot sits, so under `cargo test` — where `DEV_BUILD` is `true` — this measured
    /// the dot's top edge in every state and could no longer see the regression it was written for,
    /// a badge shortening the eye FROM ABOVE. The dot has its own rule below.
    #[test]
    fn the_eye_is_the_same_size_in_every_state() {
        let slash_left = 0.5 - EYE_A * 0.55 - STROKE / 2.0;
        let clean = ((slash_left.min(BADGE_C.0 - BADGE_R) - COL_LEFT) / COLS * W as f64) as u32;
        assert!(clean >= 3, "no column is free of the slash and the badge: {clean}");

        let extent = |state: TrayState| {
            let buf = shipped(state);
            let rows: Vec<u32> = (0..H)
                .filter(|y| (0..clean).any(|x| buf[((y * W + x) * 4 + 3) as usize] > 8))
                .collect();
            (*rows.first().expect("no ink at all"), *rows.last().unwrap())
        };
        let base = extent(TrayState::Working);
        for state in ALL {
            assert_eq!(extent(state), base, "{state:?} draws the eye at a different height");
        }
        // And across the spin, which is the reason the motion was put INSIDE the iris: an animation
        // that touched the outline would resize the mark 24 times a second, which is not a signal
        // but a glitch.
        let of_frame = |buf: &[u8]| {
            let rows: Vec<u32> = (0..H)
                .filter(|y| (0..clean).any(|x| buf[((y * W + x) * 4 + 3) as usize] > 8))
                .collect();
            (*rows.first().expect("no ink at all"), *rows.last().unwrap())
        };
        for (i, frame) in shipped_spin().iter().enumerate() {
            assert_eq!(of_frame(frame), base, "working frame {i} draws the eye at a different height");
        }
    }

    /// The development mark ADDS a dot and touches nothing else — the rule the geometry test above
    /// can no longer carry, since with the dot in there is no column on the left free of ink to
    /// measure the lens in.
    ///
    /// Stronger than an extent, and deliberately so: every pixel outside the dot's own disc has to
    /// be identical between the two builds. A mark that nudged the eye, thinned the outline or ate
    /// into the slash would fail here and nowhere else, and it would ship — the released icon is
    /// otherwise not under test at all.
    #[test]
    fn the_development_mark_only_adds_its_own_dot() {
        // Half a pixel's diagonal in unit-square terms: a pixel whose CENTRE is just outside the
        // disc can still take ink from the supersampled edge, and that is not a violation.
        let slack = ((COLS / f64::from(W) / 2.0).powi(2) + (BAND / f64::from(H) / 2.0).powi(2)).sqrt();
        for state in ALL {
            let plain = render_with(state, 0.0, false);
            let marked = render_with(state, 0.0, true);
            for py in 0..H {
                for px in 0..W {
                    let alpha = ((py * W + px) * 4 + 3) as usize;
                    if plain[alpha] == marked[alpha] {
                        continue;
                    }
                    let x = COL_LEFT + (f64::from(px) + 0.5) / f64::from(W) * COLS;
                    let y = BAND_TOP + (f64::from(py) + 0.5) / f64::from(H) * BAND;
                    let from_centre = ((x - DEV_C.0).powi(2) + (y - DEV_C.1).powi(2)).sqrt();
                    assert!(
                        from_centre <= DEV_R + slack,
                        "{state:?} differs at {px},{py}, which is outside the development dot"
                    );
                    assert!(
                        marked[alpha] > plain[alpha],
                        "{state:?} loses ink at {px},{py}: the mark adds, it never removes"
                    );
                }
            }
        }
    }

    /// The crop is tight: the mark touches all four edges of the buffer. Every transparent row or
    /// column is size the eye does not get, because macOS scales the buffer to 18 pt by HEIGHT
    /// and the width follows — margins make the icon both smaller and wider, which is the pair of
    /// complaints this geometry exists to answer. Asserted over the union of the states, since
    /// one buffer serves all of them.
    #[test]
    fn the_buffer_is_cropped_to_the_ink() {
        // The released icon, for the reason in {@link shipped}: the crop is a property of what
        // ships, and a development dot that happened to reach an edge would hide a margin.
        let painted = |x: u32, y: u32| {
            ALL.iter().any(|&s| shipped(s)[((y * W + x) * 4 + 3) as usize] > 8)
        };
        assert!((0..W).any(|x| painted(x, 0)), "an empty row at the top");
        assert!((0..W).any(|x| painted(x, H - 1)), "an empty row at the bottom");
        assert!((0..H).any(|y| painted(0, y)), "an empty column on the left");
        assert!((0..H).any(|y| painted(W - 1, y)), "an empty column on the right");
    }

    /// The buffer is non-premultiplied RGBA: a fully transparent pixel still carries the
    /// state's colour. Premultiplying would zero those channels and macOS would show a black
    /// fringe around every curve.
    #[test]
    fn transparent_pixels_keep_the_colour_channels() {
        let buf = render(TrayState::Working);
        let [r, g, b] = TrayState::Working.rgb();
        let clear = buf.chunks(4).find(|p| p[3] == 0).expect("no fully transparent pixel");
        assert_eq!([clear[0], clear[1], clear[2]], [r, g, b]);
    }
}
