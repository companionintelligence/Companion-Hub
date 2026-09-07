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
