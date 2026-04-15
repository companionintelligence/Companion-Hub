# Desktop release signing

The desktop release workflow keeps macOS signing/notarization as-is and now signs Windows installers with **Azure Artifact Signing** using **GitHub OIDC** via `azure/login`.

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
