//! Tests for the `docker_access` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn traefik_recreate_marker_can_be_set_and_cleared() {
    let tempdir = tempfile::tempdir().expect("tempdir");

    assert!(!is_traefik_recreate_required(tempdir.path()));

    mark_traefik_recreate_required(tempdir.path()).expect("mark recreate required");
    assert!(is_traefik_recreate_required(tempdir.path()));

    clear_traefik_recreate_required(tempdir.path()).expect("clear recreate required");
    assert!(!is_traefik_recreate_required(tempdir.path()));
}

/// Start engine forgets the cached check once Docker answers. A status poll that asked Docker
/// before then and heard "not running" must not cache that over the forget, or the start that
/// follows reads "Docker is not running" for five more seconds.
#[test]
fn a_check_that_began_before_docker_answered_does_not_outlive_the_forget() {
    let down = || DockerAccessCheck {
        state: DockerAccessState::DaemonUnavailable,
        detail: None,
    };
    let up = || DockerAccessCheck {
        state: DockerAccessState::Available,
        detail: None,
    };
    forget_docker_access_check();

    let polled = cached_docker_access_check(|| {
        // Docker comes up, and Start engine forgets the cache, while this poll's `docker info` runs.
        forget_docker_access_check();
        down()
    });
    let next = cached_docker_access_check(up);
    forget_docker_access_check();

    assert!(polled.state == DockerAccessState::DaemonUnavailable);
    assert!(
        next.state == DockerAccessState::Available,
        "the next check read the poll's stale answer"
    );
}
