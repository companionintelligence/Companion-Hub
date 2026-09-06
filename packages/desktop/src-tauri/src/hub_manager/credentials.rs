//! Postgres and RabbitMQ credential probing and resync.

use super::*;

const POSTGRES_DB_CONTAINER: &str = "ci-hub-db";
const POSTGRES_TCP_PROBE_RETRIES: u32 = 5;
const POSTGRES_TCP_PROBE_RETRY_DELAY_MS: u64 = 400;

fn escape_sql_literal(value: &str) -> String {
    value.replace('\'', "''")
}

fn escape_shell_single_quoted(value: &str) -> String {
    value.replace('\'', "'\\''")
}

#[derive(Debug)]
struct PostgresTcpProbeResult {
    ok: bool,
    stdout: String,
    stderr: String,
}

/// Probe Postgres TCP auth from inside the DB container (same engine, no second image).
fn postgres_tcp_auth_probe(password: &str) -> PostgresTcpProbeResult {
    let pgpassword = escape_shell_single_quoted(password);
    let script = format!(
        "PGPASSWORD='{pgpassword}' psql -h 127.0.0.1 -p 6543 -U companion -d companiondb -qt -c 'SELECT 1'"
    );
    match docker_command()
        .args(["exec", POSTGRES_DB_CONTAINER, "bash", "-lc", &script])
        .output()
    {
        Ok(out) => PostgresTcpProbeResult {
            ok: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        },
        Err(error) => PostgresTcpProbeResult {
            ok: false,
            stdout: String::new(),
            stderr: format!("Failed to exec into {POSTGRES_DB_CONTAINER}: {error}"),
        },
    }
}

/// Secondary probe via a network-attached client (kept for engines where exec TCP differs).
fn postgres_tcp_auth_probe_via_network(password: &str) -> PostgresTcpProbeResult {
    let pgpassword = escape_shell_single_quoted(password);
    let script = format!(
        "PGPASSWORD='{pgpassword}' psql -h {POSTGRES_DB_CONTAINER} -p 6543 -U companion -d companiondb -qt -c 'SELECT 1'"
    );
    match docker_command()
        .args([
            "run",
            "--rm",
            "--network",
            postgres_docker_network(),
            "postgres:14",
            "bash",
            "-lc",
            &script,
        ])
        .output()
    {
        Ok(out) => PostgresTcpProbeResult {
            ok: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        },
        Err(error) => PostgresTcpProbeResult {
            ok: false,
            stdout: String::new(),
            stderr: format!("Failed to run network Postgres probe: {error}"),
        },
    }
}

fn postgres_tcp_auth_works(password: &str) -> bool {
    let primary = postgres_tcp_auth_probe(password);
    if primary.ok {
        return true;
    }
    // Fall back only when exec path looks like a container/exec issue, not auth.
    let kind =
        crate::docker_engine::classify_postgres_probe_output(&primary.stdout, &primary.stderr);
    if kind == crate::docker_engine::PostgresProbeFailureKind::Auth {
        return false;
    }
    postgres_tcp_auth_probe_via_network(password).ok
}

fn postgres_tcp_auth_works_with_retries(
    password: &str,
) -> Result<(), (crate::docker_engine::PostgresProbeFailureKind, String)> {
    let mut last = postgres_tcp_auth_probe(password);
    if last.ok {
        return Ok(());
    }
    for _ in 1..POSTGRES_TCP_PROBE_RETRIES {
        std::thread::sleep(std::time::Duration::from_millis(
            POSTGRES_TCP_PROBE_RETRY_DELAY_MS,
        ));
        last = postgres_tcp_auth_probe(password);
        if last.ok {
            return Ok(());
        }
        let kind = crate::docker_engine::classify_postgres_probe_output(&last.stdout, &last.stderr);
        if kind == crate::docker_engine::PostgresProbeFailureKind::Auth {
            break;
        }
    }

    // One network-attached attempt if exec still looks like network/unknown.
    let kind = crate::docker_engine::classify_postgres_probe_output(&last.stdout, &last.stderr);
    if kind != crate::docker_engine::PostgresProbeFailureKind::Auth {
        let network = postgres_tcp_auth_probe_via_network(password);
        if network.ok {
            return Ok(());
        }
        last = network;
    }

    let kind = crate::docker_engine::classify_postgres_probe_output(&last.stdout, &last.stderr);
    let detail = format_command_output(&last.stdout, &last.stderr);
    Err((kind, detail))
}

fn sync_postgres_password(password: &str, data_dir: &Path) -> Result<(), String> {
    let sql = format!(
        "ALTER USER companion WITH PASSWORD '{}';",
        escape_sql_literal(password)
    );
    let mut cmd = docker_command();
    cmd.args([
        "exec",
        POSTGRES_DB_CONTAINER,
        "psql",
        "-U",
        "companion",
        "-d",
        "companiondb",
        "-p",
        "6543",
        "-c",
        &sql,
    ]);
    let output = cmd
        .output()
        .map_err(|error| format!("Failed to sync Postgres password: {}", error))?;

    if !output.status.success() {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        return Err(format!("Postgres password sync failed. {}", combined));
    }

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Synced Postgres role password to match env.",
    );
    Ok(())
}

pub(crate) fn ensure_postgres_password_matches_env(
    env_path: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let values = load_runtime_env_values(data_dir, env_path);
    let Some(password) = get_non_empty_env_value(&values, "POSTGRES_PASSWORD") else {
        return Ok(());
    };

    if postgres_tcp_auth_works(&password) {
        return Ok(());
    }

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Postgres TCP auth failed for configured password; syncing role password.",
    );

    sync_postgres_password(&password, data_dir)?;

    if let Err((kind, detail)) = postgres_tcp_auth_works_with_retries(&password) {
        let engine = crate::docker_engine::pinned_engine();
        return Err(crate::docker_engine::format_postgres_probe_failure(
            kind,
            engine.as_ref(),
            &detail,
        ));
    }

    Ok(())
}

fn rabbitmq_auth_works(password: &str) -> bool {
    docker_command()
        .args([
            "exec",
            hub_queue_name(),
            "rabbitmqctl",
            "authenticate_user",
            "companion",
            password,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn sync_rabbitmq_password(password: &str, data_dir: &Path) -> Result<(), String> {
    let output = docker_command()
        .args([
            "exec",
            hub_queue_name(),
            "rabbitmqctl",
            "change_password",
            "companion",
            password,
        ])
        .output()
        .map_err(|error| format!("Failed to change RabbitMQ password: {error}"))?;
    if output.status.success() {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            "RabbitMQ password synced via rabbitmqctl change_password.",
        );
        return Ok(());
    }
    Err(format!(
        "rabbitmqctl change_password failed: {}",
        String::from_utf8_lossy(&output.stderr)
    ))
}

fn recreate_rabbitmq_queue(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Recreating {HUB_QUEUE} so RABBITMQ_DEFAULT_PASS matches .env (no durable queue volume)."
        ),
    );
    let output = docker_command()
        .env("ENV_FILE", compose_env_file_var(env_path))
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "up",
            "-d",
            "--force-recreate",
            HUB_QUEUE,
        ])
        .output()
        .map_err(|error| format!("Failed to recreate RabbitMQ queue: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to recreate {HUB_QUEUE}: {}",
            format_command_output(
                &String::from_utf8_lossy(&output.stdout),
                &String::from_utf8_lossy(&output.stderr),
            )
        ));
    }
    wait_for_queue_healthy()
}

pub(crate) fn ensure_rabbitmq_password_matches_env(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let values = load_runtime_env_values(data_dir, env_path);
    let Some(password) = get_non_empty_env_value(&values, "RABBITMQ_PASSWORD") else {
        return Ok(());
    };

    let running = docker_command()
        .args(["inspect", "-f", "{{.State.Running}}", hub_queue_name()])
        .output()
        .map(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true"
        })
        .unwrap_or(false);
    if !running {
        return Ok(());
    }

    if rabbitmq_auth_works(&password) {
        return Ok(());
    }

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "RabbitMQ auth failed for configured password; syncing broker password.",
    );

    if sync_rabbitmq_password(&password, data_dir).is_ok() && rabbitmq_auth_works(&password) {
        return Ok(());
    }

    recreate_rabbitmq_queue(compose_path, env_path, data_dir)?;
    if !rabbitmq_auth_works(&password) {
        return Err(
            "RabbitMQ password sync/recreate did not restore authentication for user companion."
                .to_string(),
        );
    }
    Ok(())
}
