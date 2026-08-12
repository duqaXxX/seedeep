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
//! wherever they can be — a slash, three arcs, a filled core, a cross — rather than by colour
//! alone. The one pair that shares a shape is working-vs-waiting, and it is blue against amber:
//! the pair that survives the common colour-vision deficiencies best.
//!
//! The mark is a LENS WITH NO HANDLE: a thick ring of glass with a trace inside it — three spans
//! stepping to the right, the shape the Trace tab draws. It replaced an eye, which said
//! surveillance about a tool that only ever reads, and then a fingerprint, which turned out to be
//! the OpenVPN padlock's skeleton — an arc over a round body — in the very menu bar this icon
//! lives in. The handle went with it: it was the source of both objections to a magnifier, being
//! a diagonal that fought the unreachable slash and the stroke that makes the glyph read as
//! "search", which seedeep already spends a tab of its own on.

use tauri::image::Image;

/// The tray icon's id. Named once because two places have to agree on it: the builder that creates
/// the icon, and the poll that repaints it from each reading.
pub const TRAY_ID: &str = "seedeep";

/// The buffer, cropped to the ink on BOTH axes. Because macOS fits the height to 18 pt, a square
/// buffer around a mark wider than tall left the old eye filling 55% of the height — drawn at
/// ~10 pt in an 18 pt slot, visibly lighter than every neighbouring icon.
///
/// The lens is a circle, so the buffer is SQUARE — the first version of this icon that is, and the
/// smallest it has been: 26×26 against the eye's 36×26 and the print's 25×26. Both numbers are
/// DERIVED from the geometry below — see `COL_LEFT`.
const W: u32 = 26;
const H: u32 = 26;

/// The mark is designed in the unit square; these map the buffer onto the slice of that square
/// which carries ink, so only the framing moved. The window has to hold every state at once — the
/// arcs, the badge inside their opening, and the slash.
///
/// DERIVED rather than guessed: all four are the glass ring's outer edge, and nothing else in the
/// mark reaches it — the badge is sized and placed to sit INSIDE that circle rather than beside
/// it. Change `GLASS_R` and these four numbers are what has to be recomputed, or the mark grows
/// transparent margins that shrink it.
const COL_LEFT: f64 = 0.13;
const COLS: f64 = 0.74;
const BAND_TOP: f64 = 0.13;
const BAND: f64 = 0.74;

/// Supersampling factor per axis. 4 gives 16 samples a pixel — enough for a curve this small.
const SS: u32 = 4;

/// The glass: one thick ring, drawn in every state and never animated. It is this mark's outline,
/// which is what `the_mark_is_the_same_size_in_every_state` measures.
///
/// Drawn at exactly the weight of a span, which is the maintainer's call made on four renders at
/// 18 pt. The ring started half again as heavy as the trace it sits over — a mismatch with no
/// reason behind it — and the two ways to settle it are to meet in the middle or to bring the ring
/// down to the bars. This is the second: a lighter mark, at the cost of some of the ink that
/// keeps a lens from reading as a plain thin circle.
const GLASS_R: f64 = 0.37;
const GLASS_STROKE: f64 = 0.075;
/// Inside the glass: where the trace is drawn.
const INNER_R: f64 = GLASS_R - GLASS_STROKE;

/// The three spans, as (left, right, centre-y) in the unit square, stepping right the way the
/// Trace tab lays a waterfall out.
///
/// The stagger is the whole point — three bars of equal length and start would be a list, and a
/// list in a circle reads as a menu button. Each one starts where the one above it is roughly
/// half done, which is what a nested span looks like on a real trace.
///
/// How far they run from the glass is a LOOK, and it was picked by rendering three clearances: the
/// bars first reached to within 0.4 px of the ring at 18 pt, which reads as crowding rather than as
/// a trace. These leave about 1.7 px.
const SPANS: [(f64, f64, f64); 3] = [
    (0.34, 0.50, 0.38),
    (0.40, 0.58, 0.50),
    (0.45, 0.63, 0.62),
];
/// How thick a span is drawn, and how thick it gets when a session is waiting.
///
/// Waiting has to differ from idle by SHAPE and not by colour alone, and inside a ring there is
/// nowhere to add a mark that is not already spoken for — so what changes is the trace's mass:
/// the same three spans, thicker. At 18 pt that is the difference between a third of the circle
/// inked and most of it.
const SPAN_H: f64 = 0.075;
const SPAN_H_FULL: f64 = 0.095;

/// Transparent gap around the slash. Without it the slash merges into the arcs it crosses at
/// 18 pt and the icon turns into a blob.
const MOAT: f64 = 0.04;

/// How far the slash reaches, as a fraction of the outer arc's radius.
///
/// It crosses the trace and stops inside the glass rather than cutting the ring, and the margin is
/// not stylistic: the slash carries the MOAT with it, including a disc of it around each tip, and a
/// longer slash puts that disc into the leftmost columns — the only ones
/// `the_mark_is_the_same_size_in_every_state` has left to measure the mark's height in. Lengthen
/// this and that test goes red with "no column is free of the slash".
const SLASH_REACH: f64 = 0.50;

/// Whether THIS BUILD is a checkout being developed — defined once, in `local.rs`, because the
/// connection screen needs the same fact to word its "nothing to start" message.
use crate::local::DEV_BUILD;

/// The development mark: a small disc riding the glass from the INSIDE, lower left.
///
/// Deliberately SMALLER than {@link BADGE_R} and diagonally opposite it, so the two are told apart
/// at 18 pt by size as well as by place — the badge means "more than one session is waiting" and
/// changes while you watch, this one never changes at all. Inside rather than outside because it
/// carries no moat (see `is_ink`) and because anything crossing `GLASS_R` would push the ink box
/// out and shrink the lens. Every state carries it, because what it marks is the BUILD.
const DEV_C: (f64, f64) = (0.295, 0.705);
const DEV_R: f64 = 0.07;

/// The badge, in the same unit-square coordinates as the arcs. It sits in the mouth of the print,
/// centred under it: the tips of the outer arc reach y ≈ 0.865, and a disc of this radius at this
/// height ends at exactly that line, so the badge costs the mark no height at all. That is the
/// point — an earlier badge given a corner of its own forced the eye it then sat beside to shrink,
/// and a mark that resizes as it changes meaning reads as a glitch rather than as information.
const BADGE_C: (f64, f64) = (0.723, 0.277);
const BADGE_R: f64 = 0.12;

/// The slice missing from the arcs, as a fraction of a full turn: a window that sweeps along them
/// while a session works.
///
/// It is a HOLE that travels rather than a lit segment, for the same reason the eye's iris was a
/// hole: what a menu bar reads at 18 pt is a change in mass, and taking ink away from a mark that
/// is otherwise whole is the largest change this shape can make without growing.
const SWEEP: f64 = 0.13;

/// Frames in one sweep, and how fast they are shown — 24 steps across the arcs, one pass every
/// two seconds.
///
/// **The rate is what it costs**, and the cost is the platform's rather than ours: the frames are
/// rasterised once, and each one is a `set_icon`, which on macOS redraws the menu bar item.
/// Measured on the bundled app, panel closed, one session working, as 30 s samples of process CPU
/// time: **24 fps = 10.9% of one core (one sample), 12 fps = 7.3% (7.3 / 7.3 / 7.7 over three),
/// nothing working = 0.3%**. 12 is the maintainer's call, made on those numbers.
///
/// Note what the pair says: HALVING the rate did not halve the cost. Something under `set_icon` is
/// paid per repaint and something is paid per second regardless, so buying smoothness back is
/// cheaper than the first measurement suggested — and any further cut has less and less to win.
///
/// The frame COUNT stays 24 at the lower rate, so the window moves a 24th of the drawn sweep a
/// step and takes two seconds to cross it. Halving the frames instead would double the step, which
/// is where a moving mark starts to read as a stutter — and it is judged out of the corner of the
/// eye, on whether the motion is smooth.
pub const SPIN_FRAMES: u32 = 24;
pub const SPIN_FPS: u32 = 12;

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
    /// way to give it room is to shrink the mark until the primary signal is the thing that
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

/// Distance from the point to a SEGMENT rather than to the line through it, so a stroke stops at
/// its endpoints instead of running off the buffer.
fn seg_distance(x: f64, y: f64, a: (f64, f64), b: (f64, f64)) -> f64 {
    let (vx, vy) = (b.0 - a.0, b.1 - a.1);
    let t = (((x - a.0) * vx + (y - a.1) * vy) / (vx * vx + vy * vy)).clamp(0.0, 1.0);
    ((x - (a.0 + t * vx)).powi(2) + (y - (a.1 + t * vy)).powi(2)).sqrt()
}

/// Distance from the point to the icon's diagonal slash.
fn slash_distance(x: f64, y: f64) -> f64 {
    // Proportional to the arcs rather than fixed points on the square: the endpoints are what
    // decide how far the slash overshoots, and a pair written for one set of proportions silently
    // pokes out of a different one — extending the ink box, which is the mark's whole size budget.
    // Slightly inside the outer arc on both ends is intended: the slash crosses the print, it does
    // not frame it.
    seg_distance(
        x,
        y,
        (0.5 - GLASS_R * SLASH_REACH, 0.5 + GLASS_R * SLASH_REACH),
        (0.5 + GLASS_R * SLASH_REACH, 0.5 - GLASS_R * SLASH_REACH),
    )
}

/// Is this point in the glass ring?
fn in_glass(x: f64, y: f64) -> bool {
    let r = ((x - 0.5).powi(2) + (y - 0.5).powi(2)).sqrt();
    (r - (GLASS_R - GLASS_STROKE / 2.0)).abs() <= GLASS_STROKE / 2.0
}

/// Is this point on span `i`, drawn `h` thick and `grow` of the way out from its left end?
///
/// Round caps, because a span is a rounded bar everywhere else in seedeep and a flat cut at 18 pt
/// reads as a broken line.
fn on_span(x: f64, y: f64, i: usize, h: f64, grow: f64) -> bool {
    let (left, right, cy) = SPANS[i];
    let right = left + (right - left) * grow;
    seg_distance(x, y, (left, cy), (right, cy)) <= h / 2.0
}

/// The trace, at a given thickness, with every span run out `grow` of its length.
///
/// ALL THREE move together while a session works, and that is the whole point of the motion: one
/// span growing shifted about 4 px of ink at 18 pt, which is a signal nobody can see. What a
/// moving mark is judged on at this size is how much ink moves.
fn on_trace(x: f64, y: f64, h: f64, grow: f64) -> bool {
    (0..3).any(|i| on_span(x, y, i, h, grow))
}

/// Is this point painted? Every layer is either the state's one colour or nothing, so coverage
/// is a boolean and the antialiasing below is a plain average — no per-layer compositing.
///
/// `phase` places the sweeping window: 0.0 ≤ phase < 1.0, one full pass. Every other state ignores
/// it — nothing else in this mark moves.
fn is_ink(state: TrayState, phase: f64, x: f64, y: f64, dev: bool) -> bool {
    // The badge RIDES the glass rather than sitting beside it — one given a corner of its own would
    // push the ink box out and shrink the lens, which is the regression
    // `the_mark_is_the_same_size_in_every_state` exists to catch. It carries a moat, or it would
    // weld itself to the ring and read as a lump rather than as a count.
    if state.badge() {
        if in_disc(x, y, BADGE_C, BADGE_R) {
            return true;
        }
        if in_disc(x, y, BADGE_C, BADGE_R + MOAT) {
            return false;
        }
    }

    // No moat on this one, unlike the badge: it may only ADD ink. A moat would eat into the glass,
    // and `the_development_mark_only_adds_its_own_dot` refuses that — rightly, since a mark that
    // thinned the outline would ship without any other test noticing. So it is placed where it
    // needs none: riding the ring from the inside, where it reads as a swelling of the glass.
    if dev && in_disc(x, y, DEV_C, DEV_R) {
        return true;
    }

    if state == TrayState::Unreachable {
        let d = slash_distance(x, y);
        if d <= GLASS_STROKE / 2.0 {
            return true;
        }
        if d <= GLASS_STROKE / 2.0 + MOAT {
            return false;
        }
    }

    // The glass is this mark's outline: drawn in every state, and nothing animated ever touches
    // it, which is what lets the lens keep exactly the same size while it works.
    if in_glass(x, y) {
        return true;
    }

    match state {
        // Empty glass: nothing to read, so nothing is drawn inside it. "Unreachable" is not
        // merely a dimmer "idle".
        TrayState::Unreachable => false,
        // Reachable and inactive — the whole trace, still.
        TrayState::Idle => on_trace(x, y, SPAN_H, 1.0),
        // The trace BREATHES: every span runs out from its own left edge and starts over. A trace
        // filling in is what a live one does, and it is the largest change this shape can make
        // without touching the glass. The growth is spread across the whole cycle rather than
        // finishing early and holding — a held frame is one the next frame repeats, and
        // `the_working_trace_moves_on_every_frame` refuses that.
        TrayState::Working => on_trace(x, y, SPAN_H, 0.15 + 0.85 * phase),
        // Stopped on the user: the same trace, THICKER, and still. The stillness is half the
        // message — the motion means "working, leave it alone", so a waiting icon that also moved
        // would say both.
        TrayState::Waiting { .. } => on_trace(x, y, SPAN_H_FULL, 1.0),
        // Dead: the plain mark, in red. The maintainer's call, made looking at it beside waiting —
        // a cross had carried this state before, and the whole trace is a busier field for one to
        // sit in than the eye's iris was.
        //
        // What keeps it off colour ALONE, which is the rule this state has always been the hard
        // case for: waiting THICKENS its bars and this does not. That is a smaller difference than
        // a cross was, and a red-green deficiency reads red-against-amber worst of any pair, so it
        // is the weakest shape difference this icon carries — asserted, at the mass it actually
        // has, by `a_failed_icon_differs_from_a_waiting_one_by_its_shape`.
        TrayState::Failed { .. } => on_trace(x, y, SPAN_H, 1.0),
    }
}

/// Render one state as a non-premultiplied RGBA buffer, `W`×`H`, at one phase of the sweeping
/// window — see {@link is_ink}. Every state but `Working` renders identically at every phase.
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

/// One full pass of the working sweep, in order.
///
/// Rendered ONCE and handed to the poll to cycle: the alternative is rasterising the mark `SPIN_FPS`
/// times a second forever, and the whole pass is 24 × 3.0 KB — a rounding error in memory against
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

    /// Every frame of the working sweep, as raw buffers — what the menu bar actually cycles through.
    fn spin_frames() -> Vec<Vec<u8>> {
        (0..SPIN_FRAMES)
            .map(|i| render_at(TrayState::Working, f64::from(i) / f64::from(SPIN_FRAMES)))
            .collect()
    }

    /// The RELEASED icon: what a user's menu bar shows, which is what every geometry rule is about.
    ///
    /// `render` cannot answer that question here. `DEV_BUILD` is `tauri::is_dev()`, and the CLI
    /// passes `--features tauri/custom-protocol` only on `tauri build` — so under `cargo test` the
    /// dot is on, and a rule measuring the mark's edge was measuring the dot instead.
    fn shipped(state: TrayState) -> Vec<u8> {
        render_with(state, 0.0, false)
    }

    /// The released icon across the whole sweep — see {@link shipped}.
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
        // Mid-sweep too: the frame at phase 0 has the window at one tip, where it takes away the
        // least ink, so a dump of it alone cannot show what the motion looks like.
        for (i, phase) in [(6, 0.25), (12, 0.5)] {
            let buf = render_with(TrayState::Working, phase, false);
            std::fs::write(dir.join(format!("working{i}-prod.rgba")), buf).unwrap();
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

    /// The breath is a breath: no two frames of the pass are the same image, so the trace really
    /// does move on every repaint. A window that stepped only every other frame would still look
    /// animated in a still render and cost the same repaints a second for half the motion.
    #[test]
    fn the_working_trace_moves_on_every_frame() {
        let frames = spin_frames();

        for (i, a) in frames.iter().enumerate() {
            for (j, b) in frames.iter().enumerate().skip(i + 1) {
                assert_ne!(a, b, "working frames {i} and {j} are the same image");
            }
        }
    }

    /// The mark the poll paints for a still state is a frame of the same geometry — `render` is
    /// `render_at(_, 0.0)`, and `spin()` starts there. Asserted so the two entry points cannot
    /// drift into rendering two different prints.
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
    ///
    /// **The bar was lowered on purpose, and this is the record of it.** While broken carried a
    /// cross the two differed by most of the ink, and the rule demanded a QUARTER of it. Broken is
    /// now the plain mark in red (the maintainer's call, made looking at the pair at 18 pt), so all
    /// that separates them is waiting's thicker bars: **measured at 21% of the ink**. The threshold
    /// is 15% — under the fact and far above zero, which is the value that matters. A change making
    /// broken identical to waiting in shape, leaving hue as the only signal, still fails here.
    #[test]
    fn a_failed_icon_differs_from_a_waiting_one_by_its_shape() {
        let lit = |b: &[u8]| b.chunks(4).map(|p| p[3]).collect::<Vec<_>>();
        let failed = lit(&render(TrayState::Failed { count: 1 }));
        let waiting = lit(&render(TrayState::Waiting { count: 1 }));
        // Not merely `!=`: a mark differing in a handful of pixels differs on paper and nowhere a
        // menu bar can show it.
        let apart = failed.iter().zip(&waiting).filter(|(a, b)| a.abs_diff(**b) > 8).count();
        let ink = failed.iter().filter(|a| **a > 8).count();
        assert!(
            apart * 100 > ink * 15,
            "only {apart} pixels differ, against {ink} of ink — too close to see"
        );
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
    /// produced exactly that: the badge needed room, so the mark shrank to make it, and a mark
    /// that resizes as it changes meaning reads as a glitch rather than as information.
    ///
    /// Measured in the columns where ONLY the glass can put ink — left of both the badge and the
    /// slash's cap. Derived from the geometry rather than written as a number: an earlier version
    /// hard-coded a column that stopped excluding the slash the moment the proportions changed,
    /// and failed for the right reason with the wrong explanation.
    ///
    /// Rendered through {@link shipped}, never `render`: the development dot sits in the opening,
    /// and a rule that could see it would be measuring the dot in every state instead of the
    /// regression it was written for — a badge shortening the mark. The dot has its own rule below.
    #[test]
    fn the_mark_is_the_same_size_in_every_state() {
        let slash_left = 0.5 - GLASS_R * SLASH_REACH - GLASS_STROKE / 2.0 - MOAT;
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
            assert_eq!(extent(state), base, "{state:?} draws the mark at a different height");
        }
        // And across the sweep, which is the reason the outer arc is never animated: a motion that
        // touched the outline would resize the mark 24 times a second, which is not a signal but a
        // glitch.
        let of_frame = |buf: &[u8]| {
            let rows: Vec<u32> = (0..H)
                .filter(|y| (0..clean).any(|x| buf[((y * W + x) * 4 + 3) as usize] > 8))
                .collect();
            (*rows.first().expect("no ink at all"), *rows.last().unwrap())
        };
        for (i, frame) in shipped_spin().iter().enumerate() {
            assert_eq!(of_frame(frame), base, "working frame {i} draws the mark at a different height");
        }
    }

    /// The development mark ADDS a dot and touches nothing else — the rule the geometry test above
    /// cannot carry, since the dot sits in the opening where the badge and the arcs' tips also are.
    ///
    /// Stronger than an extent, and deliberately so: every pixel outside the dot's own disc has to
    /// be identical between the two builds. A mark that nudged the arcs, thinned a stroke or ate
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
    /// column is size the mark does not get, because macOS scales the buffer to 18 pt by HEIGHT
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
