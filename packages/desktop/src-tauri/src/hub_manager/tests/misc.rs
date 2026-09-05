//! Tests for the `misc` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn parses_docker_context_host_from_inspect_output() {
    let inspect_output = r#"[{
            "Name": "desktop-linux",
            "Endpoints": {
                "docker": {
                    "Host": "unix:///home/test/.docker/desktop/docker.sock"
                }
            }
        }]"#;

    assert_eq!(
        crate::docker_engine::docker_context_host_from_inspect_output(inspect_output),
        Some("unix:///home/test/.docker/desktop/docker.sock".to_string())
    );
}

#[test]
fn unreachable_desktop_falls_through_to_system_affinity() {
    // Selection matrix: Desktop not in reachable set; system has Hub stack.
    use crate::docker_engine::{
        select_docker_engine, DockerEngineCandidate, DockerEngineKind, ReachableEngine,
    };
    let engines = vec![ReachableEngine {
        candidate: DockerEngineCandidate {
            label: "system".to_string(),
            docker_host: "unix:///var/run/docker.sock".to_string(),
            kind: DockerEngineKind::System,
            context_name: None,
        },
        has_hub_identity: true,
        hub_host_ports: vec!["6543".to_string()],
    }];
    let (selected, reason) = select_docker_engine(&engines, None).unwrap();
    assert_eq!(selected.docker_host, "unix:///var/run/docker.sock");
    assert!(reason.contains("affinity"));
}
