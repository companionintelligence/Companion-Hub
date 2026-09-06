//! Tests for the `status` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn startup_progress_keeps_private_vpn_visible_but_non_blocking() {
    let (core, optional) = startup_service_definitions(true);

    assert_eq!(core.len(), 4);
    assert!(core
        .iter()
        .any(|(container, label, _)| *container == "ci-hub" && *label == "Hub backend"));
    assert!(core
        .iter()
        .any(|(container, label, _)| *container == "ci-hub-queue" && *label == "Message queue"));
    assert!(optional
        .iter()
        .any(|(container, label, required)| *container == "hub-tailscale"
            && *label == "Private VPN"
            && !required));
}

#[test]
fn startup_progress_does_not_treat_ollama_as_compose_container() {
    let (_, optional) = startup_service_definitions(false);

    assert!(!optional
        .iter()
        .any(|(container, _, _)| *container == "ci-hub-ollama"));
}
