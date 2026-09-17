//! Resize edges for the main window where Tauri builds it with GTK (Linux and the BSDs).
//!
//! tauri.linux.conf.json creates the main window undecorated, so GTK draws no resize
//! borders around it. tao shows resize cursors only for pointer events that reach the
//! GTK window itself, and the webview fills the window and takes every one of them.
//! Tauri's own webview handler starts a resize from a thin band along the edges, but it
//! never changes the cursor, so nothing shows that the edge can be dragged.
//!
//! [`install`] sees the webview's pointer events before Tauri's handler and before
//! WebKit. Near an edge it shows the matching resize cursor and starts the resize on a
//! press. Everywhere else the page gets its events as usual.

use std::{cell::RefCell, rc::Rc};

use gtk::{gdk, glib, prelude::*};

/// Minimum width of the resize band inside each window edge, in GTK logical pixels.
const EDGE_BAND: f64 = 8.0;

/// Tauri's webview handler resizes from this many pixels of an edge, times the GTK scale
/// factor. The band is never narrower, so every press that resizes also shows the cursor.
const TAURI_EDGE_BAND: i32 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResizeEdge {
    North,
    South,
    East,
    West,
    NorthEast,
    NorthWest,
    SouthEast,
    SouthWest,
}

impl ResizeEdge {
    fn gdk_edge(self) -> gdk::WindowEdge {
        match self {
            Self::North => gdk::WindowEdge::North,
            Self::South => gdk::WindowEdge::South,
            Self::East => gdk::WindowEdge::East,
            Self::West => gdk::WindowEdge::West,
            Self::NorthEast => gdk::WindowEdge::NorthEast,
            Self::NorthWest => gdk::WindowEdge::NorthWest,
            Self::SouthEast => gdk::WindowEdge::SouthEast,
            Self::SouthWest => gdk::WindowEdge::SouthWest,
        }
    }

    fn cursor_name(self) -> &'static str {
        match self {
            Self::North => "n-resize",
            Self::South => "s-resize",
            Self::East => "e-resize",
            Self::West => "w-resize",
            Self::NorthEast => "ne-resize",
            Self::NorthWest => "nw-resize",
            Self::SouthEast => "se-resize",
            Self::SouthWest => "sw-resize",
        }
    }
}

fn edge_band(scale_factor: i32) -> f64 {
    EDGE_BAND.max(f64::from(TAURI_EDGE_BAND * scale_factor))
}

/// The edge that a press at (`x`, `y`) resizes, in a `width` × `height` window with a
/// `band` wide resize band. Within twice the band of a corner, the band resizes both
/// edges, so corners are easier to grab.
fn resize_edge_at(x: f64, y: f64, width: f64, height: f64, band: f64) -> Option<ResizeEdge> {
    if x < 0.0 || y < 0.0 || x >= width || y >= height {
        return None;
    }
    if x >= band && y >= band && x < width - band && y < height - band {
        return None;
    }

    let corner = band * 2.0;
    let north = y < corner;
    let south = y >= height - corner;
    let west = x < corner;
    let east = x >= width - corner;

    match (north, south, west, east) {
        (true, _, true, _) => Some(ResizeEdge::NorthWest),
        (true, _, _, true) => Some(ResizeEdge::NorthEast),
        (_, true, true, _) => Some(ResizeEdge::SouthWest),
        (_, true, _, true) => Some(ResizeEdge::SouthEast),
        (true, _, _, _) => Some(ResizeEdge::North),
        (_, true, _, _) => Some(ResizeEdge::South),
        (_, _, true, _) => Some(ResizeEdge::West),
        (_, _, _, true) => Some(ResizeEdge::East),
        _ => None,
    }
}

/// The resize cursor showing on the webview, and the page cursor it replaced.
#[derive(Default)]
struct EdgeCursor {
    edge: Option<ResizeEdge>,
    resize_cursor: Option<gdk::Cursor>,
    /// Put back when the pointer leaves the band.
    page_cursor: Option<gdk::Cursor>,
    /// The webview window whose cursor changes are watched.
    watched_window: Option<glib::WeakRef<gdk::Window>>,
}

/// Adds resize edges to the webview that fills an undecorated GTK window.
pub fn install(view: &impl IsA<gtk::Widget>) {
    let view = view.as_ref();
    view.add_events(
        gdk::EventMask::POINTER_MOTION_MASK
            | gdk::EventMask::BUTTON_PRESS_MASK
            | gdk::EventMask::LEAVE_NOTIFY_MASK,
    );

    let state = Rc::new(RefCell::new(EdgeCursor::default()));
    view.connect_event(move |view, event| match event.event_type() {
        gdk::EventType::MotionNotify => match edge_under_pointer(view, event) {
            Some(edge) if !buttons_held(event) => {
                show_resize_cursor(view, edge, &state);
                glib::Propagation::Stop
            }
            _ => {
                restore_page_cursor(view, &state);
                glib::Propagation::Proceed
            }
        },
        gdk::EventType::ButtonPress if event.button() == Some(1) => {
            match (edge_under_pointer(view, event), toplevel_window(view)) {
                (Some(edge), Some(window)) => {
                    let (root_x, root_y) = event.root_coords().unwrap_or((0.0, 0.0));
                    window.begin_resize_drag(
                        edge.gdk_edge(),
                        1,
                        root_x as i32,
                        root_y as i32,
                        event.time(),
                    );
                    glib::Propagation::Stop
                }
                _ => glib::Propagation::Proceed,
            }
        }
        gdk::EventType::LeaveNotify => {
            restore_page_cursor(view, &state);
            glib::Propagation::Proceed
        }
        _ => glib::Propagation::Proceed,
    });
}

fn toplevel_window(view: &gtk::Widget) -> Option<gtk::Window> {
    view.toplevel()?.downcast().ok()
}

fn edge_under_pointer(view: &gtk::Widget, event: &gdk::Event) -> Option<ResizeEdge> {
    // Event coordinates are relative to the event's window, so use only the view's own.
    let view_window = view.window()?;
    if event.window().as_ref() != Some(&view_window) {
        return None;
    }
    let (x, y) = event.coords()?;
    let edge = resize_edge_at(
        x,
        y,
        f64::from(view.allocated_width()),
        f64::from(view.allocated_height()),
        edge_band(view.scale_factor()),
    )?;

    let window = toplevel_window(view)?;
    let fullscreen = window
        .window()
        .is_some_and(|window| window.state().contains(gdk::WindowState::FULLSCREEN));
    let resizable =
        !window.is_decorated() && window.is_resizable() && !window.is_maximized() && !fullscreen;
    resizable.then_some(edge)
}

/// A button held down means a drag inside the page, such as a text selection, that
/// the band must not interrupt.
fn buttons_held(event: &gdk::Event) -> bool {
    let buttons = gdk::ModifierType::BUTTON1_MASK
        | gdk::ModifierType::BUTTON2_MASK
        | gdk::ModifierType::BUTTON3_MASK
        | gdk::ModifierType::BUTTON4_MASK
        | gdk::ModifierType::BUTTON5_MASK;
    event.state().is_some_and(|state| state.intersects(buttons))
}

fn show_resize_cursor(view: &gtk::Widget, edge: ResizeEdge, state: &Rc<RefCell<EdgeCursor>>) {
    let Some(view_window) = view.window() else {
        return;
    };
    // Setting a cursor notifies the watcher, which borrows the state, so every
    // `set_cursor` call happens after the borrow ends.
    let resize_cursor = {
        let mut current = state.borrow_mut();
        if current.edge == Some(edge) {
            return;
        }
        let Some(resize_cursor) =
            gdk::Cursor::from_name(&view_window.display(), edge.cursor_name())
        else {
            return;
        };
        if current.edge.is_none() {
            current.page_cursor = view_window.cursor();
        }
        current.edge = Some(edge);
        current.resize_cursor = Some(resize_cursor.clone());

        let watched = current
            .watched_window
            .as_ref()
            .and_then(|window| window.upgrade());
        if watched.as_ref() != Some(&view_window) {
            current.watched_window = Some(view_window.downgrade());
            let state = Rc::clone(state);
            view_window.connect_cursor_notify(move |view_window| {
                keep_resize_cursor(view_window, &state);
            });
        }
        resize_cursor
    };
    view_window.set_cursor(Some(&resize_cursor));
}

/// WebKit sets the page's cursor on the same window whenever the page asks for one,
/// which can arrive after the pointer has entered the band. While a resize cursor is
/// showing, keep it, and remember the page's latest cursor for when the pointer leaves.
fn keep_resize_cursor(view_window: &gdk::Window, state: &Rc<RefCell<EdgeCursor>>) {
    let resize_cursor = {
        let mut current = state.borrow_mut();
        let Some(resize_cursor) = current.resize_cursor.clone() else {
            return;
        };
        let cursor = view_window.cursor();
        if cursor.as_ref() == Some(&resize_cursor) {
            return;
        }
        current.page_cursor = cursor;
        resize_cursor
    };
    view_window.set_cursor(Some(&resize_cursor));
}

fn restore_page_cursor(view: &gtk::Widget, state: &Rc<RefCell<EdgeCursor>>) {
    let page_cursor = {
        let mut current = state.borrow_mut();
        if current.edge.take().is_none() {
            return;
        }
        current.resize_cursor = None;
        current.page_cursor.take()
    };
    if let Some(view_window) = view.window() {
        view_window.set_cursor(page_cursor.as_ref());
    }
}

#[cfg(test)]
mod tests {
    use super::{edge_band, resize_edge_at, ResizeEdge};

    const WIDTH: f64 = 1280.0;
    const HEIGHT: f64 = 800.0;
    const BAND: f64 = 8.0;

    fn edge(x: f64, y: f64) -> Option<ResizeEdge> {
        resize_edge_at(x, y, WIDTH, HEIGHT, BAND)
    }

    #[test]
    fn band_is_never_narrower_than_tauris_press_band() {
        assert_eq!(edge_band(1), 8.0);
        assert_eq!(edge_band(2), 10.0);
        assert_eq!(edge_band(3), 15.0);
    }

    #[test]
    fn inside_the_band_resizes_the_nearest_edge() {
        assert_eq!(edge(640.0, 0.0), Some(ResizeEdge::North));
        assert_eq!(edge(640.0, 7.9), Some(ResizeEdge::North));
        assert_eq!(edge(640.0, 799.0), Some(ResizeEdge::South));
        assert_eq!(edge(640.0, 792.0), Some(ResizeEdge::South));
        assert_eq!(edge(0.0, 400.0), Some(ResizeEdge::West));
        assert_eq!(edge(1279.0, 400.0), Some(ResizeEdge::East));
        assert_eq!(edge(1272.0, 400.0), Some(ResizeEdge::East));
    }

    #[test]
    fn content_just_inside_the_band_is_left_to_the_page() {
        assert_eq!(edge(640.0, 8.0), None);
        assert_eq!(edge(640.0, 791.9), None);
        assert_eq!(edge(8.0, 400.0), None);
        assert_eq!(edge(1271.9, 400.0), None);
        assert_eq!(edge(640.0, 400.0), None);
        // Near a corner but off the band.
        assert_eq!(edge(10.0, 10.0), None);
    }

    #[test]
    fn corners_resize_diagonally_along_both_edges() {
        assert_eq!(edge(2.0, 2.0), Some(ResizeEdge::NorthWest));
        assert_eq!(edge(15.0, 2.0), Some(ResizeEdge::NorthWest));
        assert_eq!(edge(2.0, 15.0), Some(ResizeEdge::NorthWest));
        assert_eq!(edge(16.0, 2.0), Some(ResizeEdge::North));
        assert_eq!(edge(2.0, 16.0), Some(ResizeEdge::West));
        assert_eq!(edge(1270.0, 3.0), Some(ResizeEdge::NorthEast));
        assert_eq!(edge(3.0, 790.0), Some(ResizeEdge::SouthWest));
        assert_eq!(edge(1279.0, 799.0), Some(ResizeEdge::SouthEast));
        assert_eq!(edge(1265.0, 795.0), Some(ResizeEdge::SouthEast));
    }

    #[test]
    fn points_outside_the_window_are_ignored() {
        assert_eq!(edge(-1.0, 400.0), None);
        assert_eq!(edge(640.0, -0.5), None);
        assert_eq!(edge(1280.0, 400.0), None);
        assert_eq!(edge(640.0, 800.0), None);
    }
}
