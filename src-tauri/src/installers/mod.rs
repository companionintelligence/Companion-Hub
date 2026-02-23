pub mod windows;
pub mod macos;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstallProgress {
    pub step: String,
    pub progress: u8, // 0-100
    pub status: InstallStatus,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum InstallStatus {
    Pending,
    InProgress,
    Complete,
    Failed,
    Skipped,
}
