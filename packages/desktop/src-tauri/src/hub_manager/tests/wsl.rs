//! Tests for the `wsl` module.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use crate::docker_engine::{DockerEngineKind, PinnedDockerEngine};
use crate::hub_manager::{
    wsl_engine_should_revive, wsl_keepalive_args, KeepaliveProcess, KeepaliveStart, KeepaliveState,
    WslKeepalive,
};

fn engine(kind: DockerEngineKind) -> PinnedDockerEngine {
    PinnedDockerEngine {
        docker_host: "tcp://127.0.0.1:2375".to_string(),
        kind,
        context_name: None,
        reason: "test".to_string(),
        selected_at: 0,
        path_style: None,
    }
}

#[test]
fn a_stopped_wsl_engine_is_started_again_unless_the_user_stopped_the_hub() {
    let wsl = engine(DockerEngineKind::WslEngine);

    assert!(wsl_engine_should_revive(Some(&wsl), false));
    assert!(!wsl_engine_should_revive(Some(&wsl), true));
    assert!(!wsl_engine_should_revive(
        Some(&engine(DockerEngineKind::Desktop)),
        false
    ));
    assert!(!wsl_engine_should_revive(None, false));
}

#[test]
fn the_keepalive_runs_the_logon_scripts_command_as_root() {
    assert_eq!(
        wsl_keepalive_args("Ubuntu").join(" "),
        "-d Ubuntu -u root -- sleep infinity"
    );
}

/// A keepalive that ends when the test says so.
struct FakeKeepalive(Rc<Cell<KeepaliveState>>);

impl KeepaliveProcess for FakeKeepalive {
    fn state(&mut self) -> KeepaliveState {
        self.0.get()
    }
}

#[test]
fn one_keepalive_at_a_time_and_another_once_wsl_stops_it() {
    // Each keepalive started, in order, so the test can end the latest one.
    let started: RefCell<Vec<Rc<Cell<KeepaliveState>>>> = RefCell::new(Vec::new());
    let spawn = || {
        let state = Rc::new(Cell::new(KeepaliveState::Running));
        started.borrow_mut().push(Rc::clone(&state));
        Ok(FakeKeepalive(state))
    };
    let end_latest = |state| {
        if let Some(latest) = started.borrow().last() {
            latest.set(state);
        }
    };
    let start = Instant::now();
    let at = |secs| start + Duration::from_secs(secs);
    let mut keepalive = WslKeepalive::new();

    assert_eq!(keepalive.state(), None);
    assert_eq!(
        keepalive.ensure(at(0), false, spawn),
        Ok(KeepaliveStart::Started)
    );
    // Every status poll asks while Docker boots; one keepalive is enough, even when forced.
    assert_eq!(
        keepalive.ensure(at(2), false, spawn),
        Ok(KeepaliveStart::AlreadyRunning)
    );
    assert_eq!(
        keepalive.ensure(at(4), true, spawn),
        Ok(KeepaliveStart::AlreadyRunning)
    );

    // `wsl --terminate` ends it. The polls wait out the pause; Start engine doesn't.
    end_latest(KeepaliveState::Exited(Some(1)));
    assert_eq!(keepalive.state(), Some(KeepaliveState::Exited(Some(1))));
    assert_eq!(
        keepalive.ensure(at(10), false, spawn),
        Ok(KeepaliveStart::TooSoon)
    );
    assert_eq!(
        keepalive.ensure(at(10), true, spawn),
        Ok(KeepaliveStart::Started)
    );
    assert_eq!(keepalive.state(), Some(KeepaliveState::Running));

    end_latest(KeepaliveState::Exited(None));
    assert_eq!(
        keepalive.ensure(at(40), false, spawn),
        Ok(KeepaliveStart::Started)
    );
    assert_eq!(started.borrow().len(), 3);
}

#[test]
fn a_keepalive_that_cannot_start_is_retried_by_the_polls_only_after_a_pause() {
    let attempts = Cell::new(0);
    let fail = || -> Result<FakeKeepalive, String> {
        attempts.set(attempts.get() + 1);
        Err("No Ubuntu or Debian WSL distro was found for the Docker engine.".to_string())
    };
    let start = Instant::now();
    let mut keepalive = WslKeepalive::new();

    assert!(keepalive.ensure(start, false, fail).is_err());
    assert_eq!(
        keepalive.ensure(start + Duration::from_secs(5), false, fail),
        Ok(KeepaliveStart::TooSoon)
    );
    assert!(keepalive
        .ensure(start + Duration::from_secs(5), true, fail)
        .is_err());
    assert!(keepalive
        .ensure(start + Duration::from_secs(36), false, fail)
        .is_err());
    assert_eq!(attempts.get(), 3);
}
