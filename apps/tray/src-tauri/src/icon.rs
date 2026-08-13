//! The menu-bar icon, DRAWN rather than shipped as image files.
//!
//! Exported assets would be one file per state per size, all re-cut by hand whenever the mark
//! changes, and none of which a test can say anything about. Drawing them from one geometry
//! keeps a single source of truth and makes the states assertable —
//! `icon_states_are_distinguishable` is the test that an asset pipeline cannot have.
//!
//! The mark is a LENS WITH NO HANDLE: a ring of glass with a trace inside it — three bars stepping
//! to the right, the shape the Trace tab draws. It replaced an eye, which said surveillance about a
//! tool that only ever reads, and then a fingerprint, which turned out to be the OpenVPN padlock's
//! skeleton in the very menu bar this icon lives in. The handle went with it: it was the source of
//! both objections to a magnifier, being a diagonal that fought the unreachable slash and the
//! stroke that makes the glyph read as "search", which seedeep already spends a tab of its own on.
//!
//! **Everything here is measured in PIXELS OF AN 18×18 GRID, not in a unit square, and that is the
//! whole reason the icon is legible.** macOS pins the tray image to 18 POINTS
//! (`nsimage.setSize`, tray-icon `platform_impl/macos`) — on a 1× screen that is eighteen pixels
//! for the entire mark, and the glass leaves about thirteen of them inside itself. Drawn in
//! fractions of a unit square, every edge landed part-way across a pixel and macOS filled the
//! difference with grey: three bars whose gaps came out under a pixel merged into a smudge, which
//! is what "the icon looks blurred" turned out to mean. With the geometry on whole pixels the gaps
//! are a pixel of daylight each.
//!
//! The buffer ships at 36 — twice the grid — so a 2× screen gets one buffer pixel per screen pixel
//! and a 1× screen halves it exactly. Every number below must therefore stay a whole number of
//! grid pixels, or the halving lands back on fractions.
//!
//! The states are told apart by SHAPE wherever they can be — a slash, bars, longer bars, a turning
//! gap — rather than by colour alone. The one pair that shares a shape is broken-vs-waiting, and it
//! is red against amber; see `a_failed_icon_differs_from_a_waiting_one_by_its_shape`.

use tauri::image::Image;

/// The tray icon's id. Named once because two places have to agree on it: the builder that creates
/// the icon, and the poll that repaints it from each reading.
pub const TRAY_ID: &str = "seedeep";

/// The design grid: the mark is drawn on 18×18 and the buffer is rendered at twice that.
///
/// SCALE is not a quality knob — it is the only value that keeps both screens exact. At 2 the
/// buffer is 36: 1:1 on retina, an exact halving on 1×. At 3 a 1× screen would divide by three and
/// every edge would land on a third of a pixel, which is the blur this geometry exists to avoid.
const GRID: u32 = 18;
const SCALE: u32 = 2;
const W: u32 = GRID * SCALE;
const H: u32 = GRID * SCALE;

/// Supersampling factor per axis. 4 gives 16 samples a pixel — enough for a curve this small.
const SS: u32 = 4;

/// The centre of the grid, and the glass drawn around it.
///
/// The mark fills the box: the outer radius IS half the grid, so the ink touches all four edges and
/// no row is wasted — `the_buffer_is_cropped_to_the_ink` asserts it. The stroke is 2 px because 1 px
/// greys out on a light menu bar and 3 px closes the circle up on what it has to hold.
const C: f64 = 9.0;
const R_OUT: f64 = 9.0;
const STROKE: f64 = 2.0;
const R_MID: f64 = R_OUT - STROKE / 2.0;

/// The trace: `(x0, x1, y_top)` in grid pixels, each bar 2 px tall, so it covers `y_top..y_top+2`.
///
/// They step right the way a waterfall does — three bars of equal start and length would be a list,
/// and a list in a circle reads as a menu button. The rows sit 4 px apart, which is 2 px of bar and
/// 2 px of daylight: the smallest spacing that survives at this size, and the one the previous
/// geometry could not give.
const BARS: [(f64, f64, f64); 3] = [(5.0, 10.0, 4.0), (7.0, 13.0, 8.0), (9.0, 14.0, 12.0)];

/// Waiting draws the trace HEAVIER: 3 px bars instead of 2, each one as long as the circle allows
/// at its own rows.
///
/// Both dimensions, because one was not enough. Longer bars alone moved 7% of the ink, and the
/// pair this has to be told apart from — broken, in red — is the one a red-green deficiency reads
/// worst, so the difference has to be a shape difference a menu bar can show. Thicker and longer
/// together is about a fifth of the ink, and the rule that guards it is
/// `a_failed_icon_differs_from_a_waiting_one_by_its_shape`.
///
/// The lengths are not free: a bar's widest row is the one furthest from the centre, and the glass
/// closes in fast. At y = 15 the ring leaves x 5.4..12.6, which is why the bottom bar is the short
/// one here — it is the price of the extra pixel of height.
const BARS_FULL: [(f64, f64, f64); 3] = [(5.0, 11.0, 4.0), (7.0, 14.0, 8.0), (8.0, 12.0, 12.0)];
/// How thick a waiting bar is drawn.
const BAR_H_FULL: f64 = 3.0;

/// The bar height, and how thick the slash is drawn.
const BAR_H: f64 = 2.0;
const SLASH_H: f64 = 2.0;
/// How far the slash runs from the centre, along the diagonal.
const SLASH_REACH: f64 = 5.5;
/// Transparent gap around the slash, so it does not weld itself to the glass it crosses.
const MOAT: f64 = 1.0;

/// The slice of the ring left undrawn while a session works, as a fraction of a full turn.
///
/// The motion moved from the bars to the GLASS on the maintainer's call, and the size is why it
/// works: the bars are the smallest thing in the mark and moving them shifted about four pixels of
/// ink, which nobody sees. A gap running round the ring moves the largest shape the icon has, and
/// is legible out of the corner of the eye — which is how a menu bar is read.
const GAP: f64 = 0.22;

/// Frames in one turn of the gap, and how fast they are shown — 24 steps, one turn every two
/// seconds.
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
/// The frame COUNT stays 24 at the lower rate, so the gap moves 15° a step. Halving the frames
/// instead would step 30°, which is where a moving mark starts to read as a stutter — and it is
/// judged out of the corner of the eye, on whether the motion is smooth.
pub const SPIN_FRAMES: u32 = 24;
pub const SPIN_FPS: u32 = 12;

/// The badge: a disc riding the glass at the upper right, with a moat of its own.
///
/// Inside the box rather than beside it — a badge given a corner of its own would push the ink box
/// out and shrink the lens, which is the regression `the_mark_is_the_same_size_in_every_state`
/// exists to catch.
const BADGE_C: (f64, f64) = (14.0, 4.0);
const BADGE_R: f64 = 2.5;

/// The development mark: a smaller disc inside the glass, lower left.
///
/// Diagonally opposite the badge and smaller, so the two are told apart at this size by place as
/// well as by size. It carries NO moat and may only ADD ink — see `is_ink` — so it is placed where
/// it needs none.
const DEV_C: (f64, f64) = (5.0, 13.0);
const DEV_R: f64 = 1.5;

/// Whether THIS BUILD is a checkout being developed — defined once, in `local.rs`, because the
/// connection screen needs the same fact to word its "nothing to start" message.
use crate::local::DEV_BUILD;

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

/// Is this point inside a disc?
fn in_disc(x: f64, y: f64, c: (f64, f64), r: f64) -> bool {
    let (dx, dy) = (x - c.0, y - c.1);
    dx * dx + dy * dy <= r * r
}

/// Is this point on the glass ring?
fn on_glass(x: f64, y: f64) -> bool {
    ((x - C).hypot(y - C) - R_MID).abs() <= STROKE / 2.0
}

/// Where a point sits round the glass, in turns clockwise from 12 o'clock.
fn turn_at(x: f64, y: f64) -> f64 {
    (((y - C).atan2(x - C) / std::f64::consts::TAU) + 0.25).rem_euclid(1.0)
}

/// Is this point inside the gap that runs round the ring at `phase`?
fn in_gap(phase: f64, x: f64, y: f64) -> bool {
    (turn_at(x, y) - phase).rem_euclid(1.0) < GAP
}

/// Is this point on one of `bars`? Square ends, not round: at 2 px a round cap is one faded
/// corner, and a faded corner at this size is exactly the softness this geometry removes.
fn on_bars(x: f64, y: f64, bars: &[(f64, f64, f64); 3], h: f64) -> bool {
    bars.iter().any(|&(x0, x1, top)| x >= x0 && x <= x1 && y >= top && y <= top + h)
}

/// Distance from the point to the slash, measured along and across the diagonal.
fn slash(x: f64, y: f64) -> (f64, f64) {
    let (dx, dy) = (x - C, y - C);
    let across = (dx + dy).abs() / std::f64::consts::SQRT_2;
    let along = (dx - dy).abs() / std::f64::consts::SQRT_2;
    (across, along)
}

/// Is this point painted? Every layer is either the state's one colour or nothing, so coverage
/// is a boolean and the antialiasing below is a plain average — no per-layer compositing.
///
/// `phase` places the gap running round the glass: 0.0 ≤ phase < 1.0, one full turn. Every other
/// state ignores it — nothing else in this mark moves.
fn is_ink(state: TrayState, phase: f64, x: f64, y: f64, dev: bool) -> bool {
    if state.badge() {
        if in_disc(x, y, BADGE_C, BADGE_R) {
            return true;
        }
        if in_disc(x, y, BADGE_C, BADGE_R + MOAT) {
            return false;
        }
    }

    // No moat on this one, unlike the badge: it may only ADD ink, which
    // `the_development_mark_only_adds_its_own_dot` asserts — a mark that thinned the glass would
    // ship without any other test noticing. So it sits where it needs none.
    if dev && in_disc(x, y, DEV_C, DEV_R) {
        return true;
    }

    if state == TrayState::Unreachable {
        let (across, along) = slash(x, y);
        if along <= SLASH_REACH {
            if across <= SLASH_H / 2.0 {
                return true;
            }
            if across <= SLASH_H / 2.0 + MOAT {
                return false;
            }
        }
    }

    match state {
        // The glass, with the gap running round it. Nothing else moves, and the ring is otherwise
        // whole in every state — which is what keeps the mark the same size while it works.
        TrayState::Working => on_glass(x, y) && !in_gap(phase, x, y) || on_bars(x, y, &BARS, BAR_H),
        // Empty glass: nothing to read, so nothing is drawn inside it. "Unreachable" is not merely
        // a dimmer "idle".
        TrayState::Unreachable => on_glass(x, y),
        TrayState::Idle => on_glass(x, y) || on_bars(x, y, &BARS, BAR_H),
        // Stopped on the user: the same trace, HEAVIER, and still. The stillness is half the
        // message — the motion means "working, leave it alone", so a waiting icon that also moved
        // would say both.
        TrayState::Waiting { .. } => on_glass(x, y) || on_bars(x, y, &BARS_FULL, BAR_H_FULL),
        // Dead: the plain mark, in red. The maintainer's call, made looking at it beside waiting.
        // What keeps it off colour ALONE is that waiting runs its bars out further and this does
        // not — the weakest shape difference this icon carries, asserted at the mass it actually
        // has by `a_failed_icon_differs_from_a_waiting_one_by_its_shape`.
        TrayState::Failed { .. } => on_glass(x, y) || on_bars(x, y, &BARS, BAR_H),
    }
}

/// Render one state as a non-premultiplied RGBA buffer, `W`×`H`, at one phase of the gap running
/// round the glass — see {@link is_ink}. Every state but `Working` renders identically at every
/// phase.
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
                    // Buffer pixel → grid pixel. The buffer is SCALE times the grid, so this is
                    // where the whole-pixel geometry above meets the rasteriser.
                    let x = (f64::from(px) + (f64::from(sx) + 0.5) / f64::from(SS)) / f64::from(SCALE);
                    let y = (f64::from(py) + (f64::from(sy) + 0.5) / f64::from(SS)) / f64::from(SCALE);
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

    /// The turn is a turn: no two frames are the same image, so the gap really does move on every
    /// repaint. A window that stepped only every other frame would still look
    /// animated in a still render and cost the same repaints a second for half the motion.
    #[test]
    fn the_working_gap_moves_on_every_frame() {
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
        // The columns where only the glass can put ink: left of the slash's reach and of the
        // badge. In grid pixels, scaled up to buffer columns.
        let slash_left = C - SLASH_REACH / std::f64::consts::SQRT_2 - SLASH_H / 2.0 - MOAT;
        let clean = (slash_left.min(BADGE_C.0 - BADGE_R - MOAT) * f64::from(SCALE)) as u32;
        assert!(clean >= 3, "no column is free of the slash and the badge: {clean}");

        let extent = |state: TrayState| {
            let buf = shipped(state);
            let rows: Vec<u32> = (0..H)
                .filter(|y| (0..clean).any(|x| buf[((y * W + x) * 4 + 3) as usize] > 8))
                .collect();
            (*rows.first().expect("no ink at all"), *rows.last().unwrap())
        };
        let base = extent(TrayState::Idle);
        for state in ALL {
            assert_eq!(extent(state), base, "{state:?} draws the mark at a different height");
        }
        // Working is measured as an ENVELOPE, not frame by frame, and the difference is the point.
        // The gap now travels the glass itself, so on the frames where it passes the left of the
        // ring those columns really are empty — a per-frame equality would fail on a motion that is
        // correct. What must not change is the box the mark occupies over a turn: the union of the
        // frames has to be exactly the still mark's extent, which catches an animation that grows
        // the icon while leaving each frame plausible on its own.
        let union: Vec<u8> = shipped_spin().iter().fold(vec![0u8; (W * H) as usize], |mut acc, f| {
            for i in 0..acc.len() {
                acc[i] = acc[i].max(f[i * 4 + 3]);
            }
            acc
        });
        let rows: Vec<u32> = (0..H)
            .filter(|y| (0..clean).any(|x| union[(y * W + x) as usize] > 8))
            .collect();
        assert_eq!(
            (*rows.first().expect("no ink at all"), *rows.last().unwrap()),
            base,
            "the working turn draws the mark at a different height"
        );
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
        // Half a buffer pixel, in grid units: a pixel whose CENTRE is just outside the disc can
        // still take ink from the supersampled edge, and that is not a violation.
        let slack = (0.5f64 / f64::from(SCALE)) * std::f64::consts::SQRT_2;
        for state in ALL {
            let plain = render_with(state, 0.0, false);
            let marked = render_with(state, 0.0, true);
            for py in 0..H {
                for px in 0..W {
                    let alpha = ((py * W + px) * 4 + 3) as usize;
                    if plain[alpha] == marked[alpha] {
                        continue;
                    }
                    let x = (f64::from(px) + 0.5) / f64::from(SCALE);
                    let y = (f64::from(py) + 0.5) / f64::from(SCALE);
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
