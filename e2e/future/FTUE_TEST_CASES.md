# FTUE full-integration test cases

This is the acceptance matrix for the one-page first-time user experience (FTUE). The primary automated lane is
[`onboarding-ai-setup.spec.ts`](onboarding-ai-setup.spec.ts), run with `pnpm e2e:future:onboarding`.

## Fidelity boundaries

| Boundary | Test implementation | Why |
|---|---|---|
| Browser UI | Real React Router frontend in Chromium | Exercises the same forms, validation, responsive layout, requests, and progress UI as an operator. |
| Hub API | Real compiled NestJS backend | Exercises auth guards, onboarding profile selection, preferences, model orchestration, app lifecycle, and completion. |
| Persistence | Real PostgreSQL database | Verifies the saved backend, endpoints, models, and onboarding state rather than browser-only state. |
| Work queues | Real RabbitMQ publishers and consumers | Verifies that Docker installs cross the production RPC boundary. Queue names use the `ftue-e2e-` scope so a running development Hub cannot consume test jobs. |
| App installer | Real Docker daemon and Compose lifecycle | A uniquely named E2E fixture is presented as OnlyOffice in the test UI, starts a digest-pinned multi-architecture BusyBox container, and is verified through cleanup. Its Compose project cannot collide with a real OnlyOffice install. |
| Inference engines | Deterministic HTTP protocol fixture | Implements the Ollama, mlx-dspark, MTPLX, vLLM, Lucebox, and Lemonade endpoints needed for health, discovery, pull, load, and failure cases without downloading multi-gigabyte models. Every request is recorded for contract assertions. |
| Desktop bridge | Browser-injected Tauri IPC contract | Verifies requested runner sets and returned endpoints. It intentionally does not install Homebrew, Python, LaunchAgents, or real models on the test host. Those remain native smoke tests. |
| CI Portal | Deterministic mock Portal | Keeps registration and auth behavior reproducible without modifying production accounts. |
| Hardware | Fixed Apple M2 Ultra host snapshot | Makes macOS backend ordering and model recommendations deterministic in local and CI runs. |

## Automated acceptance cases

| ID | Scenario and setup | Operator actions | Required assertions |
|---|---|---|---|
| FTUE-E2E-001 | New operator on a 96 GB Apple Silicon Mac; all inference fixtures initially healthy. | Sign in and open `/onboarding`. | Real backend reports `darwin`/`arm64`, high tier, and mlx-dspark recommendation; CI brain mark and title render; mlx-dspark is selected above MTPLX; Lemonade is hidden on macOS; OpenClaw and the single Companion Memory checkbox default on; exactly 20 private-app rows and their icons render. |
| FTUE-E2E-002 | Same operator at a 390 × 844 viewport. | Toggle Companion Memory, select the last private app, and scroll through the page. | Logo and title centers differ by at most 2 px; no horizontal overflow; exactly one Memory checkbox controls the option; the last app remains selectable and is not obscured by the sticky footer. |
| FTUE-E2E-003 | MTPLX fixture is offline; desktop Tauri IPC is available. | Choose MTPLX, re-check, run automatic setup, then finish. | Offline guidance appears; IPC receives exactly `['mtplx']`; returned endpoint becomes healthy through the real backend; endpoint is saved as `preferredMtplxUrl`; backend preference is `mtplx`; completion opens Home. |
| FTUE-E2E-004 | vLLM fixture is healthy and accepts a synthetic key. | Choose vLLM, enter an endpoint and API key, re-check, then finish. | Backend probes `/v1/models` at the typed endpoint with `Authorization: Bearer …`; no key appears in a URL; endpoint and key persist through the preferences API; backend preference is `vllm`; completion opens Home. |
| FTUE-E2E-005 | Lucebox fixture exposes health and one served model. | Choose Speculative inference, re-check, then finish with no install work. | Browser causes real backend probes of `/health` and `/v1/models`; backend preference is `lucebox`; no model pull is attempted; completion opens Home. |
| FTUE-E2E-006 | mlx-dspark fixture is offline and empty; desktop IPC is available; Ollama is healthy. | Run automatic mlx-dspark setup, choose a fresh catalog model, then finish. | IPC first receives `['dspark']`; endpoint becomes healthy; selecting the model calls `/admin/load` with the exact backend model ID; preferences save the dspark URL/model; finish co-starts exactly `['dspark', 'ollama']`; completion opens Home. |
| FTUE-E2E-007 | Ollama fixture has embeddings but not the selected chat model. | Choose Ollama and select the smallest fresh chat model. | Pull streams through `/api/pull`; tracker reaches pulled/loaded/pinned; finish warms the model through `/api/generate`; backend and preferred model persist; completion opens Home. |
| FTUE-E2E-008 | OnlyOffice recommendation selected; real Docker, PostgreSQL, and RabbitMQ are available. | Deselect default optional work, select OnlyOffice, and finish. | Install POST is accepted; UI transitions to Running; exactly one container with the E2E service label exists; image is BusyBox; Continue opens Home; teardown removes only resources carrying the exact fixture service or Compose-project labels. |
| FTUE-E2E-009 | Completion endpoint returns one synthetic 503, then succeeds. | Finish an empty setup and continue. | Frontend retries once without operator input, performs exactly two completion requests, shows no terminal error, and opens Home. |
| FTUE-E2E-010 | Completion endpoint returns a synthetic 400 until the operator retries. | Finish, click Continue, observe failure, then retry after the route recovers. | Validation failure is not automatically retried; page stays on onboarding with actionable error; manual retry issues the second request and opens Home. |

## Complete functional matrix

`Automated` means the case is in the full-integration lane above. `Candidate` is a detailed next case for this lane. `Native` requires a disposable machine because it changes host services or downloads real models.

| ID | Priority | Area | Preconditions and stimulus | Expected result | Status |
|---|---|---|---|---|---|
| FTUE-AUTH-001 | P0 | Entry | Signed-out browser requests `/onboarding`. | Redirect to Login; no protected profile or preference data is rendered. | Candidate |
| FTUE-AUTH-002 | P0 | Entry | Authenticated operator has `hasCompletedOnboarding=false`. | Onboarding loads and remains the active route after refresh. | Covered by all automated cases |
| FTUE-AUTH-003 | P0 | Entry | Authenticated operator has completed onboarding and requests `/onboarding`. | Redirect to Home unless an explicit supported reset/reconfigure path is used. | Candidate |
| FTUE-AUTH-004 | P1 | Session | Session expires while a model or app install is visible. | Progress stops safely, re-authentication is requested, and duplicate install work is not submitted. | Candidate |
| FTUE-SYS-001 | P0 | Hardware | Deterministic Apple Silicon host probe. | Profile, tier, storage, Apple badge, mlx-dspark default, and catalog budget agree. | Automated: FTUE-E2E-001 |
| FTUE-SYS-002 | P1 | Hardware | Operator chooses Rescan after the host probe changes. | Spinner is bounded; fresh profile replaces stale values; choices that remain valid are preserved. | Candidate |
| FTUE-SYS-003 | P0 | Hardware | Profile API fails once, then recovers. | Error state names the failed setup; Retry reloads the profile without losing auth. | Candidate |
| FTUE-SYS-004 | P1 | Hardware | Host tier is insufficient. | Unsupported AI setup is hidden or blocked with useful guidance; operator can still finish supported Hub setup. | Candidate |
| FTUE-SYS-005 | P1 | Hardware | Disk or memory falls below selected model requirements. | Install is blocked before download with required/available amounts; removing the model clears the block. | Candidate |
| FTUE-ACCESS-001 | P0 | Access | Web is selected by default. | Selection is persisted in final config and remains keyboard-operable. | Candidate |
| FTUE-ACCESS-002 | P1 | Access | Private VPN is available and selected/deselected. | Tailscale setup appears only while selected; final config contains the exact access modes. | Candidate |
| FTUE-ACCESS-003 | P1 | Access | Cloudflare or Tailscale capability is unavailable. | Unavailable method cannot be selected and explains why without blocking Web. | Candidate |
| FTUE-AGENT-001 | P0 | Agent | New setup on current defaults. | OpenClaw starts selected; Hermes and OpenClaw can be selected independently according to multi-select rules. | Partially automated: FTUE-E2E-001 |
| FTUE-AGENT-002 | P1 | Agent | Operator deselects every agent. | Empty agent selection is accepted and no agent app is queued. | Exercised as setup in FTUE-E2E-008/009/010 |
| FTUE-INF-001 | P0 | Backend picker | Apple Silicon profile contains all registered backends. | mlx-dspark is the first/default speculative option, MTPLX is nested second, Lemonade is hidden, and remaining options are selectable. | Automated: FTUE-E2E-001 |
| FTUE-INF-002 | P0 | MTPLX | MTPLX is offline and desktop IPC is available. | One-click setup installs/starts MTPLX, returns its endpoint, re-probes it, and persists selection. | Automated: FTUE-E2E-003 |
| FTUE-INF-003 | P1 | MTPLX | Operator types an unreachable URL, then a healthy remote URL. | First probe shows the attempted URL and remediation; second clears the error and saves normalized URL. | Candidate |
| FTUE-INF-004 | P0 | mlx-dspark | Server is offline and desktop IPC is available. | One-click setup requests only dspark, re-probes returned endpoint, and preserves browser choices. | Automated: FTUE-E2E-006 |
| FTUE-INF-005 | P0 | mlx-dspark | Healthy server starts with `--no-model`. | Backend is ready but UI clearly says no model is loaded; selecting a model is allowed. | Partially automated: FTUE-E2E-006 |
| FTUE-INF-006 | P0 | mlx-dspark | A fresh model is selected. | Exact target is sent to `/admin/load`; only the preferred dspark model is resident and tracked. | Automated: FTUE-E2E-006 |
| FTUE-INF-007 | P0 | mlx-dspark | `/admin/load` fails or times out. | Model row reports failure, finish cannot claim success, retry resumes safely, and no false pinned state is stored. | Candidate |
| FTUE-INF-008 | P0 | Embeddings | A host-served backend is selected while Ollama is offline. | Embeddings requirement is visible; desktop finish requests selected runner plus Ollama; browser-only mode gives host guidance. | Co-start automated in FTUE-E2E-006; browser failure candidate |
| FTUE-INF-009 | P0 | Ollama | Healthy Ollama lacks selected chat model. | Streaming pull, tracker, warm load, pin, and persisted preference complete in order. | Automated: FTUE-E2E-007 |
| FTUE-INF-010 | P0 | Ollama | Ollama is absent in desktop mode. | Install control invokes the Ollama desktop command, re-probes readiness, and does not require a page reload. | Candidate |
| FTUE-INF-011 | P0 | Ollama | Pull stream returns an error after progress. | Failed state and retry are visible; Continue does not misreport completion; successful retry does not duplicate the model. | Candidate |
| FTUE-INF-012 | P0 | vLLM | Operator supplies endpoint and API key. | Key crosses the backend probe only in a header and both settings persist. | Automated: FTUE-E2E-004 |
| FTUE-INF-013 | P0 | vLLM | Server returns 401 for a bad key. | Auth-specific guidance appears; key is not logged or placed in URL/error text; corrected key clears the error. | Candidate |
| FTUE-INF-014 | P1 | vLLM | Operator clicks an unserved catalog model. | Hub does not issue a pull; model page opens externally because vLLM must restart with the model. | Candidate |
| FTUE-INF-015 | P0 | Lucebox | External server is healthy with a configured model. | Health/model discovery succeeds and no Hub pull is attempted. | Automated: FTUE-E2E-005 |
| FTUE-INF-016 | P1 | Lucebox | External server is unavailable. | Setup remains selected, endpoint-specific guidance appears, re-check recovers, and Continue is blocked until ready or backend changes. | Candidate |
| FTUE-INF-017 | P1 | Lemonade | Non-macOS fixture exposes Lemonade and a fresh model. | Backend is selectable; `/v1/pull` then `/v1/load` run; model and preference persist. | Candidate: cross-platform profile lane |
| FTUE-INF-018 | P1 | Platform matrix | NVIDIA, AMD/ROCm, Apple, CPU-only, Linux, Windows, and macOS profiles are loaded in turn. | Backend visibility, recommendation, install guidance, model catalog, and memory budget match each platform contract. | Candidate: data-driven lane |
| FTUE-MODEL-001 | P0 | Selection | Recommended, small, medium, large, embedding, and other-model groups render. | Counts match profile, accordions expose every row, and checkboxes map to exact catalog IDs. | Candidate |
| FTUE-MODEL-002 | P1 | Selection | Preferred model is deselected while another compatible agent model remains. | Preferred model falls back deterministically; incompatible backend models are not saved. | Candidate |
| FTUE-MODEL-003 | P1 | Resources | Several models exceed disk or inference-memory budget together. | Aggregate meter and blocker update immediately and recover after deselection. | Candidate |
| FTUE-MEM-001 | P0 | Companion Memory | Default Memory option is toggled from desktop and mobile layouts. | Exactly one accessible checkbox owns the state; outer card and inner content never diverge. | Automated on mobile: FTUE-E2E-002 |
| FTUE-MEM-002 | P1 | Companion Memory | Memory remains selected through finish. | Correct app is queued once, icon/name remain visible, and privacy copy is present. | Candidate |
| FTUE-APP-001 | P0 | Private apps | Deterministic 20-app alternatives catalog loads. | All 20 rows render without an internal scroll area; each proprietary chip and alternative has an icon; every alternative checkbox is enabled. | Partially automated: FTUE-E2E-001/002 |
| FTUE-APP-002 | P0 | Docker install | One recommendation is selected. | Real API, RabbitMQ, worker, Compose, container health, progress row, and cleanup all succeed. | Automated: FTUE-E2E-008 |
| FTUE-APP-003 | P0 | Docker failure | Fixture image pull or health check fails. | Row reaches a terminal failed state with reason and retry; completed rows are not rolled back. | Candidate |
| FTUE-APP-004 | P1 | Multiple installs | Three recommendations with mixed durations are selected. | Queue order/progress stays coherent, each app has one row/container, and Continue waits only for terminal states. | Candidate |
| FTUE-APP-005 | P1 | Idempotency | Finish is double-clicked or network response is replayed. | Each selected app/model is submitted once and no duplicate DB/container rows appear. | Candidate |
| FTUE-DONE-001 | P0 | Completion | All optional work is deselected. | Finish remains enabled, progress reaches Continue, completion saves onboarding, and Home opens. | Exercised in FTUE-E2E-005/009/010 |
| FTUE-DONE-002 | P0 | Completion | First completion response is 503. | Exactly one automatic retry succeeds. | Automated: FTUE-E2E-009 |
| FTUE-DONE-003 | P0 | Completion | Completion response is 400. | No automatic retry; manual retry remains available and succeeds. | Automated: FTUE-E2E-010 |
| FTUE-DONE-004 | P1 | Recovery | Browser reloads during active installs. | Backend truth reconstructs progress; completed work is not repeated; operator can finish. | Candidate |
| FTUE-DONE-005 | P1 | Progress transport | SSE disconnects while polling remains available. | Progress continues or reconnects without duplicate state transitions. | Candidate |
| FTUE-UX-001 | P0 | Responsive | 390 × 844 mobile viewport traverses the full one-page form. | No horizontal overflow, controls remain selectable, and sticky footer obscures no final row. | Automated: FTUE-E2E-002 |
| FTUE-UX-002 | P1 | Desktop | 1280 px and 1800 px layouts render model/app matrices. | Columns align, content has no nested vertical scroll, and footer does not cover focused controls. | Partially automated: FTUE-E2E-001 |
| FTUE-UX-003 | P0 | Accessibility | Entire FTUE is completed with keyboard and screen-reader roles. | Logical focus order, visible focus, unique labels, status announcements, and no serious axe violations. | Candidate |
| FTUE-NATIVE-001 | P0 | macOS native | Disposable clean Apple Silicon user with no Homebrew/Python/Ollama/runners. | `hub install system setup` and FTUE install Ollama plus selected MLX runner, create private credentials and LaunchAgents, and survive logout/reboot. | Native |
| FTUE-NATIVE-002 | P0 | macOS native | Existing stale/partial venv, occupied port, or failed LaunchAgent. | Setup repairs compatible components, preserves unrelated installs, reports exact blocker, and retry converges. | Native |

## Exit criteria

- All ten automated acceptance cases pass with one worker against a dedicated test database and queue scope.
- No fixture container, network, or volume remains after the lane, including after a failed assertion.
- Test results contain no real credentials, account identifiers, or downloaded production model data.
- A release that changes native runner installation also passes FTUE-NATIVE-001 on a disposable Apple Silicon host; browser IPC coverage alone is not proof of a real Homebrew/Python/LaunchAgent install.
