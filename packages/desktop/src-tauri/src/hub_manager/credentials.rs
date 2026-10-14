//! Postgres and RabbitMQ credential probing and resync.

use super::*;

const POSTGRES_DB_CONTAINER: &str = "ci-hub-db";
const POSTGRES_TCP_PROBE_RETRIES: u32 = 5;
const POSTGRES_TCP_PROBE_RETRY_DELAY_MS: u64 = 400;
/// How long a psql command run through the copy route may take.
const POSTGRES_EXEC_TIMEOUT: Duration = Duration::from_secs(30);
/// rabbitmqctl starts an Erlang VM for every call, so it gets longer than psql.
const RABBITMQCTL_TIMEOUT: Duration = Duration::from_secs(60);

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

/// Signs in to `ci-hub-db` by name with `password` and prints `1`, for `bash -lc`.
///
/// It connects to the container's name, not to 127.0.0.1: the postgres image trusts loopback
/// connections (`host all all 127.0.0.1/32 trust` in pg_hba.conf), so a loopback probe signs in
/// whatever the password.
fn postgres_probe_script(password: &str) -> String {
    let pgpassword = escape_shell_single_quoted(password);
    format!(
        "PGPASSWORD='{pgpassword}' psql -h {POSTGRES_DB_CONTAINER} -p 6543 -U companion -d companiondb -qt -c 'SELECT 1'"
    )
}

/// Probe Postgres TCP auth from inside the DB container (same engine, no second image).
/// `psql -qt -c 'SELECT 1'` prints `1` once it has signed in.
fn postgres_tcp_auth_probe(db: &ContainerReader, password: &str) -> PostgresTcpProbeResult {
    let script = postgres_probe_script(password);
    let out = db.run(&["bash", "-lc", &script]);
    PostgresTcpProbeResult {
        ok: out.succeeded() && out.stdout.lines().any(|line| line.trim() == "1"),
        stdout: out.stdout,
        stderr: out.stderr,
    }
}

/// The networks `ci-hub-db` is attached to. When Docker can't say, `ci-hub_internal`, where compose
/// puts the database, then the Hub's shared networks. A client on `ci-hub_network` alone can't
/// resolve `ci-hub-db`.
fn postgres_probe_networks(docker: DockerCli) -> Vec<String> {
    let attached: Vec<String> = docker(&[
        "inspect",
        "-f",
        "{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}",
        POSTGRES_DB_CONTAINER,
    ])
    .ok()
    .filter(|output| output.status.success())
    .map(|output| {
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default();
    if attached.is_empty() {
        std::iter::once(HUB_INTERNAL_NETWORK)
            .chain(HUB_NETWORK_NAMES.iter().copied())
            .map(str::to_string)
            .collect()
    } else {
        attached
    }
}

/// Secondary probe via a network-attached client (kept for engines where exec TCP differs). The WSL
/// engine drops what `docker run` prints but keeps its exit status, so the status is the answer.
fn postgres_tcp_auth_probe_via_network(
    docker: DockerCli,
    password: &str,
) -> PostgresTcpProbeResult {
    let script = postgres_probe_script(password);
    let mut first_failure: Option<PostgresTcpProbeResult> = None;
    for network in postgres_probe_networks(docker) {
        let result = match docker(&[
            "run",
            "--rm",
            "--network",
            &network,
            "postgres:14",
            "bash",
            "-lc",
            &script,
        ]) {
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
        };
        if result.ok {
            return result;
        }
        first_failure.get_or_insert(result);
    }
    first_failure.unwrap_or(PostgresTcpProbeResult {
        ok: false,
        stdout: String::new(),
        stderr: format!("{POSTGRES_DB_CONTAINER} is on no network to probe from."),
    })
}

fn postgres_tcp_auth_works(db: &ContainerReader, password: &str) -> bool {
    let primary = postgres_tcp_auth_probe(db, password);
    if primary.ok {
        return true;
    }
    // Fall back only when exec path looks like a container/exec issue, not auth.
    let kind =
        crate::docker_engine::classify_postgres_probe_output(&primary.stdout, &primary.stderr);
    if kind == crate::docker_engine::PostgresProbeFailureKind::Auth {
        return false;
    }
    postgres_tcp_auth_probe_via_network(db.docker(), password).ok
}

fn postgres_tcp_auth_works_with_retries(
    db: &ContainerReader,
    password: &str,
) -> Result<(), (crate::docker_engine::PostgresProbeFailureKind, String)> {
    let mut last = postgres_tcp_auth_probe(db, password);
    if last.ok {
        return Ok(());
    }
    for _ in 1..POSTGRES_TCP_PROBE_RETRIES {
        std::thread::sleep(std::time::Duration::from_millis(
            POSTGRES_TCP_PROBE_RETRY_DELAY_MS,
        ));
        last = postgres_tcp_auth_probe(db, password);
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
        let network = postgres_tcp_auth_probe_via_network(db.docker(), password);
        if network.ok {
            return Ok(());
        }
        if network.stdout.trim().is_empty() && network.stderr.trim().is_empty() {
            // The WSL engine drops what `docker run` prints, so its failure says nothing about
            // the cause. Report the exec probe's output instead, without claiming a cause.
            return Err((
                crate::docker_engine::PostgresProbeFailureKind::Unknown,
                format_command_output(&last.stdout, &last.stderr),
            ));
        }
        last = network;
    }

    let kind = crate::docker_engine::classify_postgres_probe_output(&last.stdout, &last.stderr);
    let detail = format_command_output(&last.stdout, &last.stderr);
    Err((kind, detail))
}

/// `ALTER USER` prints `ALTER ROLE`, and setting the same password twice is harmless, so it can go
/// through the reader.
fn sync_postgres_password(
    db: &ContainerReader,
    password: &str,
    data_dir: &Path,
) -> Result<(), String> {
    let sql = format!(
        "ALTER USER companion WITH PASSWORD '{}';",
        escape_sql_literal(password)
    );
    let output = db.run(&[
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

    if !output.succeeded() {
        let combined = format_command_output(&output.stdout, &output.stderr);
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

    ensure_postgres_password_matches(&run_docker_cli, &password, data_dir)
}

/// Checks that `password` signs in as `companion`, and sets the role's password to it when not.
pub(crate) fn ensure_postgres_password_matches(
    docker: DockerCli,
    password: &str,
    data_dir: &Path,
) -> Result<(), String> {
    let db = ContainerReader::new(docker, POSTGRES_DB_CONTAINER, POSTGRES_EXEC_TIMEOUT);
    if postgres_tcp_auth_works(&db, password) {
        return Ok(());
    }

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Postgres TCP auth failed for configured password; syncing role password.",
    );

    sync_postgres_password(&db, password, data_dir)?;

    if let Err((kind, detail)) = postgres_tcp_auth_works_with_retries(&db, password) {
        let engine = crate::docker_engine::pinned_engine();
        return Err(crate::docker_engine::format_postgres_probe_failure(
            kind,
            engine.as_ref(),
            &detail,
        ));
    }

    Ok(())
}

/// Runs rabbitmqctl in `queue`. Both rabbitmqctl commands print a banner line, and running either
/// twice is harmless, so they go through the reader. Share one between calls: each new reader on
/// the WSL engine spends a direct `docker exec`, and an Erlang VM start, finding out it needs the
/// copy route.
pub(crate) fn rabbitmq_reader<'a>(docker: DockerCli<'a>, queue: &'a str) -> ContainerReader<'a> {
    ContainerReader::new(docker, queue, RABBITMQCTL_TIMEOUT)
}

pub(crate) fn rabbitmq_auth_works(queue: &ContainerReader, password: &str) -> bool {
    queue
        .run(&["rabbitmqctl", "authenticate_user", "companion", password])
        .succeeded()
}

pub(crate) fn sync_rabbitmq_password(
    queue: &ContainerReader,
    password: &str,
    data_dir: &Path,
) -> Result<(), String> {
    let output = queue.run(&["rabbitmqctl", "change_password", "companion", password]);
    if output.succeeded() {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            "RabbitMQ password synced via rabbitmqctl change_password.",
        );
        return Ok(());
    }
    Err(format!(
        "rabbitmqctl change_password failed: {}",
        output.stderr
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

    let queue = rabbitmq_reader(&run_docker_cli, hub_queue_name());
    if rabbitmq_auth_works(&queue, &password) {
        return Ok(());
    }

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "RabbitMQ auth failed for configured password; syncing broker password.",
    );

    match sync_rabbitmq_password(&queue, &password, data_dir) {
        Ok(()) if rabbitmq_auth_works(&queue, &password) => return Ok(()),
        Ok(()) => {}
        // Logged, since the queue is recreated next and nothing else says why.
        Err(error) => {
            let _ = append_desktop_log_for(data_dir, "hub.start", &error);
        }
    }

    recreate_rabbitmq_queue(compose_path, env_path, data_dir)?;
    // A new reader: the recreated queue may go by another name than the one checked above.
    if !rabbitmq_auth_works(
        &rabbitmq_reader(&run_docker_cli, hub_queue_name()),
        &password,
    ) {
        return Err(
            "RabbitMQ password sync/recreate did not restore authentication for user companion."
                .to_string(),
        );
    }
    Ok(())
}
