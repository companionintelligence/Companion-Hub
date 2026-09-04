//! Canonical Docker DNS names for the Hub appliance.
//!
//! Product / image / compose project are `ci-hub`. The retired `ci-os-hub`
//! spellings stay as network aliases and lookup fallbacks so already-installed
//! apps keep resolving after an upgrade.

pub const HUB_CONTAINER: &str = "ci-hub";
pub const LEGACY_HUB_CONTAINER: &str = "ci-os-hub";
pub const HUB_QUEUE: &str = "ci-hub-queue";
pub const LEGACY_HUB_QUEUE: &str = "ci-os-hub-queue";
pub const HUB_NETWORK: &str = "ci-hub_network";
pub const LEGACY_HUB_NETWORK: &str = "ci-os-hub_network";

pub const HUB_CONTAINER_NAMES: &[&str] = &[HUB_CONTAINER, LEGACY_HUB_CONTAINER];
pub const HUB_QUEUE_NAMES: &[&str] = &[HUB_QUEUE, LEGACY_HUB_QUEUE];
pub const HUB_NETWORK_NAMES: &[&str] = &[HUB_NETWORK, LEGACY_HUB_NETWORK];

pub const HUB_MANAGED_LABEL_FILTER: &str = "label=ci-hub.managed=true";
pub const LEGACY_HUB_MANAGED_LABEL_FILTER: &str = "label=ci-os-hub.managed=true";
pub const HUB_APPURN_LABEL_FILTER: &str = "label=ci-hub.appurn";
pub const LEGACY_HUB_APPURN_LABEL_FILTER: &str = "label=ci-os-hub.appurn";
