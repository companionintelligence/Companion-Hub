//! Tests for the `start_retry` module: the 5/15/60-minute schedule, budget exhaustion, reset,
//! and the state file. Time is passed in, so nothing sleeps.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

const MIN: u64 = 60 * 1000;

#[test]
fn first_failure_retries_after_five_minutes() {
    let (state, outcome) = record_failure_at(StartRetryState::default(), 1_000);
    assert_eq!(
        outcome,
        RetryOutcome::Scheduled {
            retry: 1,
            wait_secs: 300
        }
    );
    assert!(!retry_due_at(state, 1_000 + 5 * MIN - 1));
    assert!(retry_due_at(state, 1_000 + 5 * MIN));
}

#[test]
fn each_failed_retry_waits_longer_than_the_last() {
    let (s1, _) = record_failure_at(StartRetryState::default(), 0);
    // Retry 1 starts at 5 min and fails there.
    let (s2, outcome) = record_failure_at(s1, 5 * MIN);
    assert_eq!(
        outcome,
        RetryOutcome::Scheduled {
            retry: 2,
            wait_secs: 900
        }
    );
    assert!(!retry_due_at(s2, 5 * MIN + 15 * MIN - 1));
    assert!(retry_due_at(s2, 5 * MIN + 15 * MIN));
    // Retry 2 starts at 20 min and fails there.
    let (s3, outcome) = record_failure_at(s2, 20 * MIN);
    assert_eq!(
        outcome,
        RetryOutcome::Scheduled {
            retry: 3,
            wait_secs: 3600
        }
    );
    assert!(!retry_due_at(s3, 20 * MIN + 60 * MIN - 1));
    assert!(retry_due_at(s3, 20 * MIN + 60 * MIN));
}

#[test]
fn the_fourth_failure_exhausts_the_budget_and_nothing_is_due_after_it() {
    let (s1, _) = record_failure_at(StartRetryState::default(), 0);
    let (s2, _) = record_failure_at(s1, 5 * MIN);
    let (s3, _) = record_failure_at(s2, 20 * MIN);
    // Retry 3 starts at 80 min and fails there: the budget is spent.
    let (s4, outcome) = record_failure_at(s3, 80 * MIN);
    assert_eq!(outcome, RetryOutcome::Exhausted { tries: 3 });
    assert!(!retry_due_at(s4, 100_000 * MIN));
}

#[test]
fn a_fresh_budget_schedules_retry_one_again() {
    let (_, outcome) = record_failure_at(StartRetryState::default(), 0);
    assert_eq!(
        outcome,
        RetryOutcome::Scheduled {
            retry: 1,
            wait_secs: 300
        }
    );
}

#[test]
fn the_budget_persists_and_resets_on_request() {
    let dir = tempfile::tempdir().expect("tempdir");
    let outcome = record_start_failure(dir.path(), 0);
    assert_eq!(
        outcome,
        RetryOutcome::Scheduled {
            retry: 1,
            wait_secs: 300
        }
    );
    assert_eq!(
        start_retry_state(dir.path()),
        StartRetryState {
            failures: 1,
            last_failed_ms: 0
        }
    );
    assert!(automatic_retry_due(dir.path(), 5 * MIN));

    reset_start_retry_budget(dir.path());
    assert_eq!(start_retry_state(dir.path()), StartRetryState::default());
    assert!(!automatic_retry_due(dir.path(), 100_000 * MIN));
}

#[test]
fn an_exhausted_budget_stays_spent_across_restarts() {
    let dir = tempfile::tempdir().expect("tempdir");
    for now in [0, 5 * MIN, 20 * MIN, 80 * MIN] {
        record_start_failure(dir.path(), now);
    }
    assert_eq!(start_retry_state(dir.path()).failures, 4);
    assert!(!automatic_retry_due(dir.path(), 100_000 * MIN));
}

#[test]
fn an_unreadable_state_file_reads_as_a_fresh_budget() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(dir.path().join("start-retry.state"), "not numbers").expect("write");
    assert_eq!(start_retry_state(dir.path()), StartRetryState::default());
}
