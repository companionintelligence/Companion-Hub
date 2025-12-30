# Headless Linux Provisioning System via BLE

This package implements a "Boot-to-Cloud" provisioning system for headless Linux devices. It exposes a BLE GATT server that allows a mobile app to configure Wi-Fi credentials and perform a cryptographic attestation to link the device to a user's cloud account.

## System Architecture

*   **Language:** Python 3
*   **BLE Stack:** BlueZ (via `dbus-next`)
*   **Networking:** NetworkManager (`nmcli`)
*   **Service:** Systemd

## Directory Structure

*   `provisioning_agent.py`: Main entry point and orchestration logic.
*   `ble_server.py`: Implements the BLE GATT Server, Advertisement, and Services.
*   `network_manager.py`: Wrapper around `nmcli` for Wi-Fi management.
*   `security.py`: Handles device identity loading and HMAC-SHA256 signing.
*   `provisioning-agent.service`: Systemd unit file.

## Prerequisites

*   Linux OS with `systemd`.
*   `BlueZ` installed and running (`bluetoothd`).
*   `NetworkManager` installed and running.
*   Python 3.7+.

## Installation

1.  **Install Dependencies:**
    ```bash
    sudo apt-get install python3-pip bluez network-manager
    pip3 install -r requirements.txt
    ```

2.  **Setup Device Identity:**
    Create the file `/etc/device_identity.json` with the following content (ensure it is secured):
    ```json
    {
      "SERIAL_ID": "YOUR_DEVICE_SERIAL_ID",
      "DEVICE_SECRET": "YOUR_PRE_BURNED_SECRET_KEY"
    }
    ```
    *Secure the file:* `chmod 600 /etc/device_identity.json`

3.  **Install Systemd Service:**
    ```bash
    sudo cp provisioning-agent.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable provisioning-agent.service
    sudo systemctl start provisioning-agent.service
    ```

## BLE GATT Specification

### Advertisement
*   **Local Name:** `ServerBox-[Last4Serial]`
*   **Manufacturer Data:** `0xFFFF` -> `[SERIAL_ID_BYTES]`

### Services

#### 1. Device Information Service (`0x180A`)
*   **Serial Number (`0x2A25`):** Read-only.
*   **Hardware Revision (`0x2A27`):** Read-only.

#### 2. Connectivity Service (`0000a001-1212-efde-1523-785feabcd123`)
*   **SSID (`...a002`):** Write. UTF-8 String.
*   **Password (`...a003`):** Write. UTF-8 String.
*   **Status (`...a004`):** Read/Notify. Values: `Idle`, `Connecting`, `Connected`, `Auth_Error`, `Activated`.

#### 3. Cloud Auth Service (`0000b001-1212-efde-1523-785feabcd123`)
*   **Token (`...b002`):** Write. User Registration Token from App.

## Implementation Plan & Testing Checklist

### Phase 1: Environment Setup
- [ ] Verify `bluetoothd` is running: `systemctl status bluetooth`.
- [ ] Verify `nmcli` works: `nmcli device wifi list`.
- [ ] Create a dummy `/etc/device_identity.json`.

### Phase 2: BLE Advertisement & Connection
- [ ] Start the agent manually: `sudo python3 provisioning_agent.py`.
- [ ] Use a BLE Scanner app (e.g., nRF Connect) to find `ServerBox-XXXX`.
- [ ] Verify Manufacturer Data matches the Serial ID.
- [ ] Connect to the device.

### Phase 3: GATT Services
- [ ] Read Serial Number from Device Info Service.
- [ ] Subscribe to Status characteristic notifications.
- [ ] Write `SSID` and `Password` to the Connectivity Service.
- [ ] Verify in terminal logs that `nmcli` is attempting connection.
- [ ] Verify Status characteristic updates to `Connected`.

### Phase 4: Cloud Activation
- [ ] Write a dummy `Token` to the Cloud Auth Service.
- [ ] Verify the agent attempts a POST request to the API.
- [ ] Check logs for HMAC signature generation.
- [ ] **Mock API:** Use a tool like `httpbin` or a local server to verify the payload structure.

### Phase 5: Success State
- [ ] Ensure `/var/lib/provisioning/completed` is created upon success.
- [ ] Restart the service and verify it exits immediately if the file exists.
- [ ] Verify the BLE advertisement stops after success.

## Troubleshooting

*   **BLE Permission Errors:** Ensure the script runs as root or the user has `bluetooth` group privileges and DBus policy allows owning the name.
*   **NetworkManager Errors:** Ensure `nmcli` is available and the user has permission to modify connections.
*   **DBus Errors:** Check `dbus-monitor --system` to see the interaction between the script and BlueZ.
