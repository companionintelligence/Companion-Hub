# Desktop release signing

The desktop release workflow keeps macOS signing/notarization as-is and now signs Windows installers with **Azure Artifact Signing** using **GitHub OIDC** via `azure/login`.

## macOS signing identity

After importing `APPLE_CERTIFICATE`, the workflow **resolves the codesigning identity from the keychain** (`security find-identity`). This avoids release failures when `APPLE_SIGNING_IDENTITY` is missing or does not exactly match the imported certificate name.

- `APPLE_SIGNING_IDENTITY` (optional secret): if set and it matches an imported identity, that identity is used.
- Otherwise the workflow prefers `Developer ID Application: …` from the import keychain, then falls back to the first valid identity.

Required macOS secrets for signed releases: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, plus notarization (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`).

## Where to store the secrets

Add these as **GitHub Environment secrets** on the environment you run the release against:

- `production` — required for signed production releases
- `dev` — optional, only if you want signed prerelease/dev releases

## Required Windows signing secrets

Set these exact secret names in the target GitHub Environment:

- `AZURE_TENANT_ID` — Microsoft Entra tenant (directory) ID GUID
- `AZURE_CLIENT_ID` — App registration / service principal client ID used by GitHub Actions
- `AZURE_SUBSCRIPTION_ID` — Azure subscription ID that contains the Artifact Signing account
- `AZURE_SIGNING_ENDPOINT` — regional Artifact Signing endpoint, for example `https://eus.codesigning.azure.net/`
- `AZURE_SIGNING_ACCOUNT` — Artifact Signing account name
- `AZURE_CERTIFICATE_PROFILE` — Artifact Signing certificate profile name

`AZURE_CLIENT_SECRET` is **no longer used** by the workflow.

## Required Azure OIDC setup

Create a Microsoft Entra app registration + service principal for GitHub Actions, then add federated credentials with:

- **Issuer:** `https://token.actions.githubusercontent.com`
- **Audience:** `api://AzureADTokenExchange`
- **Subject for production releases:** `repo:companionintelligence/CI-Hub:environment:production`
- **Subject for dev releases (optional):** `repo:companionintelligence/CI-Hub:environment:dev`

Grant that service principal the **Artifact Signing Certificate Profile Signer** role on the Artifact Signing account (or a parent scope such as the resource group/subscription if that is how you manage access).

## Behaviour when secrets are missing

The workflow only attempts Windows signing when **all** required Azure secrets are present for the selected environment. If they are missing, the Windows build still completes, but the artifacts remain unsigned.

## Azure signing runbook (CI)

Use this path as the default for CI-Hub release builds because it is already wired into `.github/workflows/desktop-release.yml`.

1. **Confirm workflow prerequisites in GitHub**
   - Run release workflow with `environment=production` (or `dev`).
   - Verify all six Azure signing secrets exist in that GitHub Environment.
   - Verify workflow has `id-token: write` permission (required by `azure/login` OIDC).
2. **Confirm Azure prerequisites**
   - Artifact Signing account exists in the same subscription as `AZURE_SUBSCRIPTION_ID`.
   - Certificate profile exists and matches `AZURE_CERTIFICATE_PROFILE`.
   - Service principal from `AZURE_CLIENT_ID` has `Artifact Signing Certificate Profile Signer` role.
   - Federated credential subjects exactly match:
     - `repo:companionintelligence/CI-Hub:environment:production`
     - `repo:companionintelligence/CI-Hub:environment:dev` (optional)
3. **Run and validate signing**
   - Trigger `desktop-release.yml`.
   - In the Windows matrix job, confirm these steps run successfully:
     - `Azure login for Artifact Signing`
     - `Sign Windows artifacts`
   - Confirm signed artifacts are uploaded (`*.msi`, `*-setup.exe`).
4. **Verify signatures on a clean Windows VM**
   - PowerShell:
     ```powershell
     Get-AuthenticodeSignature .\CompanionHub-setup.exe | Format-List *
     Get-AuthenticodeSignature .\CompanionHub.msi | Format-List *
     ```
   - SignTool:
     ```powershell
     signtool verify /pa /all .\CompanionHub-setup.exe
     signtool verify /pa /all .\CompanionHub.msi
     ```
   - Expected result: valid chain + trusted timestamp, no SmartScreen “Unknown publisher”.

## Root-cause checklist for unsigned Windows artifacts

If Windows artifacts are unsigned, check in this order:

1. **Workflow gate skipped signing**
   - `WINDOWS_SIGNING_CONFIGURED` becomes false when any required secret is missing.
2. **OIDC subject mismatch**
   - Most common failure: Entra federated credential `subject` does not exactly match environment name.
3. **Missing RBAC role on certificate profile/account**
   - `azure/login` can succeed but signing still fails if signer role is missing.
4. **Wrong endpoint/account/profile combination**
   - `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, and `AZURE_CERTIFICATE_PROFILE` must belong together in the same region/account.
5. **Timestamp or network transient failures**
   - Re-run failed job and compare `Sign Windows artifacts` logs for transient timestamp/network errors.

## Certum cloud signing runbook (SignTool + jarsigner)

Use this when a Certum cloud certificate is required for distribution channels outside the current Azure path.

Reference manual:  
https://files.certum.eu/documents/manual_en/CS-Code_Signing_in_the_Cloud_Signtool_jarsigner_signing.pdf

1. **Prepare Certum environment**
   - Purchase/issue Certum Code Signing in the Cloud certificate.
   - Configure operator authentication (MFA/SimplySign) per Certum policy.
   - Install Certum-provided components required by the manual (provider/driver/middleware).
2. **Sign Windows binaries with SignTool**
   - Open “Developer PowerShell for VS”.
   - Use the provider/container values from your Certum account/manual.
   - Example template:
     ```powershell
     signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
       /csp "<Certum CSP/KSP name>" /kc "<Certum key container>" `
       .\CompanionHub-setup.exe
     ```
   - Verify:
     ```powershell
     signtool verify /pa /all .\CompanionHub-setup.exe
     ```
3. **Sign Java artifacts with jarsigner (if needed)**
   - Create PKCS#11 config according to Certum manual.
   - Example template:
     ```bash
     jarsigner -keystore NONE -storetype PKCS11 \
       -providerClass sun.security.pkcs11.SunPKCS11 \
       -providerArg certum-pkcs11.cfg \
       app.jar "<cert-alias>"
     ```
   - Verify:
     ```bash
     jarsigner -verify -verbose -certs app.jar
     ```
4. **Operational recommendation**
   - Keep Azure signing as default CI path.
   - Use Certum as fallback/secondary path only after a documented, repeatable local verification on a clean Windows VM.

## Windows Store submission runbook (Partner Center)

1. **Prerequisites**
   - Active Microsoft Partner Center account.
   - Reserved app identity (same Publisher display name/ID you plan to ship under).
   - Store-compatible package (typically MSIX/MSIXBundle; plain MSI/EXE is not submitted directly to Microsoft Store).
2. **Prepare Store package**
   - Build Store package (MSIX/MSIXBundle) with the correct identity metadata.
   - Sign package with production certificate.
   - Validate package locally:
     ```powershell
     signtool verify /pa /all .\CompanionHub.msix
     ```
3. **Submit in Partner Center**
   - Apps and games → your app → **Start a new submission**.
   - Upload package(s), complete Store listing, pricing, age ratings, and privacy fields.
   - Complete certification notes with test credentials if needed.
4. **Certification follow-up**
   - Monitor certification report for failures.
   - Fix blockers (identity mismatch, capability violations, crashes, policy issues).
   - Re-submit until certification passes.
5. **Release validation**
   - Install Store-delivered build on a clean Windows machine.
   - Confirm install/update path has no untrusted publisher warnings.
