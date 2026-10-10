//! Tests for the `wsl` module.

use std::cell::{Cell, RefCell};
use std::net::Ipv4Addr;
use std::rc::Rc;
use std::time::{Duration, Instant};

use crate::docker_engine::{DockerEngineKind, PinnedDockerEngine};
use crate::hub_manager::{
    default_gateway_from_route_table, engine_distro_from_listing, is_own_address,
    restore_wsl_engine_logon_script, wait_for_wsl_engine, write_update_listener_host,
    wsl2_engine_user_script, wsl_engine_logon_script, wsl_engine_should_revive, wsl_keepalive_args,
    EngineWait, KeepaliveProcess, KeepaliveStart, KeepaliveState, WslKeepalive,
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

#[test]
fn start_engine_replaces_the_keepalive_that_wsl_terminate_just_ended() {
    // Start engine clicked right after `wsl --terminate`: the app's keepalive still runs, then
    // ends on the next poll because its distro is gone.
    let keepalives = RefCell::new(vec![KeepaliveState::Running]);
    let polls = Cell::new(0);
    let started_at_poll: Cell<Option<u32>> = Cell::new(None);
    let outcome = wait_for_wsl_engine(
        || {
            polls.set(polls.get() + 1);
            if polls.get() == 2 {
                *keepalives.borrow_mut().last_mut().unwrap() = KeepaliveState::Exited(Some(1));
            }
            // dockerd answers three polls after a keepalive this start started.
            started_at_poll
                .get()
                .is_some_and(|at| polls.get() >= at + 3)
        },
        || {
            let mut list = keepalives.borrow_mut();
            if list.last() == Some(&KeepaliveState::Running) {
                return Ok(KeepaliveStart::AlreadyRunning);
            }
            list.push(KeepaliveState::Running);
            started_at_poll.set(Some(polls.get()));
            Ok(KeepaliveStart::Started)
        },
        || keepalives.borrow().last().copied(),
        || polls.get() >= 90,
        || {},
    );

    assert_eq!(outcome, Ok(EngineWait::Answered));
    assert_eq!(
        *keepalives.borrow(),
        vec![KeepaliveState::Exited(Some(1)), KeepaliveState::Running]
    );
}

#[test]
fn start_engine_gives_up_when_every_keepalive_ends_at_once() {
    let starts = Cell::new(0);
    let outcome = wait_for_wsl_engine(
        || false,
        || {
            starts.set(starts.get() + 1);
            Ok(KeepaliveStart::Started)
        },
        || Some(KeepaliveState::Exited(Some(-1))),
        || false,
        || {},
    );

    assert_eq!(outcome, Ok(EngineWait::KeepaliveEnded(Some(-1))));
    assert_eq!(starts.get(), 3);
}

#[test]
fn start_engine_stops_waiting_for_docker_at_the_deadline() {
    let polls = Cell::new(0);
    let outcome = wait_for_wsl_engine(
        || {
            polls.set(polls.get() + 1);
            false
        },
        || Ok(KeepaliveStart::Started),
        || Some(KeepaliveState::Running),
        || polls.get() >= 5,
        || {},
    );

    assert_eq!(outcome, Ok(EngineWait::TimedOut));
    assert_eq!(polls.get(), 5);
}

#[test]
fn start_engine_says_why_a_keepalive_could_not_start() {
    let outcome = wait_for_wsl_engine(
        || false,
        || Err("No Ubuntu WSL distro was found for the Docker engine.".to_string()),
        || None,
        || false,
        || {},
    );

    assert_eq!(
        outcome,
        Err("No Ubuntu WSL distro was found for the Docker engine.".to_string())
    );
}

/// `/proc/net/route` in the distro behind a Windows Hub on the WSL engine, as `cat` prints it:
/// the default route goes to the Windows host on the WSL adapter, 172.27.96.1.
const WSL_ROUTE_TABLE: &str =
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n\
eth0\t00000000\t01601BAC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n\
docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n\
eth0\t00601BAC\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0\n";

#[test]
fn the_windows_host_is_the_distros_default_gateway() {
    let windows_host = Some(Ipv4Addr::new(172, 27, 96, 1));

    assert_eq!(
        default_gateway_from_route_table(WSL_ROUTE_TABLE),
        windows_host
    );
    // A login shell's banner before the table changes nothing.
    assert_eq!(
        default_gateway_from_route_table(&format!("Welcome to Ubuntu\n{WSL_ROUTE_TABLE}")),
        windows_host
    );
}

#[test]
fn a_table_without_a_default_route_has_no_gateway() {
    let bridges_only =
        "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n\
docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n";

    assert_eq!(default_gateway_from_route_table(bridges_only), None);
    assert_eq!(default_gateway_from_route_table(""), None);
}

#[test]
fn only_an_address_of_this_computer_counts_as_the_host() {
    assert!(is_own_address(Ipv4Addr::LOCALHOST));
    // TEST-NET-1 (RFC 5737) is never a machine's own address.
    assert!(!is_own_address(Ipv4Addr::new(192, 0, 2, 1)));
}

#[test]
fn the_listener_address_is_written_where_the_hub_reads_it_and_removed_again() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    // The backend reads this exact file (UPDATE_LISTENER_HOST_FILENAME), and one address in it.
    let file = data_dir.path().join("state").join("update-listener.host");
    let windows_host = Some(Ipv4Addr::new(172, 27, 96, 1));

    assert_eq!(
        write_update_listener_host(data_dir.path(), windows_host),
        Ok(true)
    );
    assert_eq!(
        std::fs::read_to_string(&file).expect("written"),
        "172.27.96.1\n"
    );
    assert_eq!(
        write_update_listener_host(data_dir.path(), windows_host),
        Ok(false)
    );

    assert_eq!(write_update_listener_host(data_dir.path(), None), Ok(true));
    assert!(!file.exists());
    assert_eq!(write_update_listener_host(data_dir.path(), None), Ok(false));
}

#[test]
fn the_engine_runs_in_the_installers_ubuntu_even_when_a_debian_is_listed_first() {
    assert_eq!(
        engine_distro_from_listing("Debian\nUbuntu-22.04\n"),
        Some("Ubuntu-22.04".to_string())
    );
    assert_eq!(
        engine_distro_from_listing("docker-desktop\r\nubuntu\r\n"),
        Some("ubuntu".to_string())
    );
    assert_eq!(engine_distro_from_listing("Debian\ndocker-desktop\n"), None);
}

/// The logon script the installer's PowerShell writes with `Set-Content`, for `distro`.
fn installer_logon_script(distro: &str) -> String {
    let script = wsl2_engine_user_script();
    let value = script
        .lines()
        .find_map(|line| line.strip_prefix("Set-Content -Path $vbs -Value "))
        .expect("the installer writes the logon script");
    // A double-quoted PowerShell string: "" is one quote, and $distro expands.
    let inner = value
        .trim()
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .expect("a quoted value");
    format!(
        "{}\r\n",
        inner.replace("\"\"", "\"").replace("$distro", distro)
    )
}

#[test]
fn the_logon_script_is_the_one_the_installer_writes() {
    assert_eq!(
        wsl_engine_logon_script("Ubuntu"),
        installer_logon_script("Ubuntu")
    );
    assert_eq!(
        wsl_engine_logon_script("Ubuntu"),
        "CreateObject(\"Wscript.Shell\").Run \"wsl.exe -d Ubuntu -u root -- sleep infinity\", 0, False\r\n"
    );
}

#[test]
fn a_logon_script_the_uninstaller_removed_is_put_back_and_one_still_there_is_left_alone() {
    let startup = tempfile::tempdir().expect("Startup folder");
    let script = startup.path().join("CompanionHub-WSL-Docker.vbs");

    assert_eq!(
        restore_wsl_engine_logon_script(startup.path(), || Some("Ubuntu".to_string())),
        Ok(Some(script.clone()))
    );
    assert_eq!(
        std::fs::read_to_string(&script).expect("written"),
        installer_logon_script("Ubuntu")
    );

    // Whatever distro a script that is there names, it is not rewritten.
    std::fs::write(&script, installer_logon_script("Ubuntu-24.04")).expect("installer's script");
    assert_eq!(
        restore_wsl_engine_logon_script(startup.path(), || Some("Ubuntu".to_string())),
        Ok(None)
    );
    assert_eq!(
        std::fs::read_to_string(&script).expect("kept"),
        installer_logon_script("Ubuntu-24.04")
    );
}

#[test]
fn no_logon_script_is_written_without_the_engines_distro() {
    let startup = tempfile::tempdir().expect("Startup folder");

    assert!(restore_wsl_engine_logon_script(startup.path(), || None).is_err());
    assert!(!startup.path().join("CompanionHub-WSL-Docker.vbs").exists());
}
