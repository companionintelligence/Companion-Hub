//! Tests for the `lifecycle` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn invalidate_config_hash_removes_saved_hash() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let hash_path = tempdir.path().join(".config-hash");
    std::fs::write(&hash_path, b"abc123").expect("write hash");

    crate::hub_manager::invalidate_config_hash(tempdir.path());

    assert!(!hash_path.exists(), ".config-hash should be removed");
}

#[test]
fn persist_config_hash_writes_compose_env_fingerprint() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let compose = tempdir.path().join("docker-compose.prod.yml");
    let env = tempdir.path().join(".env");
    std::fs::write(&compose, b"services: {}\n").expect("write compose");
    std::fs::write(&env, b"ROOT_FOLDER_HOST=/data\n").expect("write env");

    crate::hub_manager::persist_config_hash(tempdir.path(), &compose, &env);

    let hash_path = tempdir.path().join(".config-hash");
    let saved = std::fs::read_to_string(&hash_path).expect("hash file");
    let expected = crate::hub_manager::compute_config_hash(&compose, &env);
    assert_eq!(saved, expected);
}

// The startup page opens the Hub only once this reads false. A launch check that panics must not
// leave it true, or the window stays on the startup page for good. And the stop the launch check
// runs inside it ending must not end the launch check.
#[test]
fn stack_change_is_pending_until_every_guard_is_dropped_even_by_a_panic() {
    let pending = || crate::hub_manager::stack_change_state().stack_change_pending;
    assert!(!pending());

    let launch_check = crate::hub_manager::StackChange::begin();
    assert!(pending());
    let stop = crate::hub_manager::StackChange::begin();
    drop(stop);
    assert!(
        pending(),
        "an inner stop ending must not end the launch check"
    );
    drop(launch_check);
    assert!(!pending());

    let panicked = std::panic::catch_unwind(|| {
        let _check = crate::hub_manager::StackChange::begin();
        panic!("launch check failed");
    });
    assert!(panicked.is_err());
    assert!(!pending());
}
