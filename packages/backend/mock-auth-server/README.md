# Mock Auth Server

This is a simple Express server designed to mock the authentication and file serving behavior for the CI App Store.

## Purpose

It serves a zipped copy of the `CI-App-Store` repository, but only if the request includes a valid `X-UUID` header. This simulates the hardware-locked access control mechanism.

## Setup

1.  **Update the Repo Zip**:
    Run the update script to download the latest `CI-App-Store` content and zip it.
    ```bash
    ./scripts/update-mock-repo.sh
    ```
    This creates `repo.zip` in this directory.

2.  **Install Dependencies**:
    Ensure you have installed the project dependencies (this server uses `express` and `adm-zip` which should be in the root `package.json` or installed via `bun add`).

## Running the Server

Run the server using `bun`:

```bash
bun run packages/backend/mock-auth-server/server.ts
```

The server will listen on `http://localhost:3001`.

## Testing

You can test the server using `curl`:

```bash
curl -v -H "X-UUID: test-uuid-1234" http://localhost:3001/download -o test.zip
```

## Configuration

-   **Port**: 3001 (hardcoded in `server.ts`)
-   **Valid UUIDs**: `['test-uuid-1234', 'valid-hardware-uuid']` (hardcoded in `server.ts`)
