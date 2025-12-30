import asyncio
import logging
import os
import sys
import time
import requests
from datetime import datetime

from security import DeviceIdentity
from network_manager import NetworkManager
from ble_server import BLEProvisioningServer

# Configuration
PROVISIONING_FLAG_FILE = "/var/lib/provisioning/completed"
API_BASE_URL = os.getenv("CLOUD_API_URL", "https://api.companionintelligence.com")
TIMEOUT_SECONDS = 20 * 60  # 20 minutes

# Logging Setup
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("ProvisioningAgent")

class ProvisioningAgent:
    def __init__(self):
        self.identity = None
        self.nm = NetworkManager()
        self.ble_server = None
        self.loop = asyncio.get_event_loop()
        self.token = None
        self.start_time = time.time()

    def check_already_provisioned(self):
        if os.path.exists(PROVISIONING_FLAG_FILE):
            logger.info("Device already provisioned. Exiting.")
            sys.exit(0)

    def on_wifi_creds(self, ssid, password):
        logger.info(f"Received Wi-Fi credentials for {ssid}")
        self.ble_server.update_status("Connecting")
        
        # Run blocking network call in executor to avoid blocking BLE loop
        success = self.nm.connect_wifi(ssid, password)
        
        if success:
            logger.info("Wi-Fi Connected")
            self.ble_server.update_status("Connected")
            self.try_activation()
        else:
            logger.error("Wi-Fi Connection Failed")
            self.ble_server.update_status("Auth_Error") # Or Connection_Error

    def on_token(self, token):
        logger.info("Received User Registration Token")
        self.token = token
        self.try_activation()

    def try_activation(self):
        if not self.nm.is_connected():
            logger.warning("Cannot activate: No Internet Connection")
            return

        if not self.token:
            logger.warning("Cannot activate: No Token")
            return

        logger.info("Attempting Cloud Activation...")
        try:
            timestamp = datetime.utcnow().isoformat() + "Z"
            signature = self.identity.sign_payload(timestamp)
            
            payload = {
                "serial_id": self.identity.get_serial_id(),
                "signature": signature,
                "token": self.token,
                "timestamp": timestamp
            }
            
            response = requests.post(f"{API_BASE_URL}/api/v1/activate", json=payload, timeout=10)
            
            if response.status_code == 200:
                logger.info("Activation Successful!")
                self.ble_server.update_status("Activated")
                self.finish_provisioning()
            else:
                logger.error(f"Activation Failed: {response.status_code} - {response.text}")
                self.ble_server.update_status("Auth_Error")
                
        except Exception as e:
            logger.error(f"Activation Exception: {e}")
            self.ble_server.update_status("Auth_Error")

    def finish_provisioning(self):
        logger.info("Finalizing provisioning...")
        # Create flag file
        try:
            os.makedirs(os.path.dirname(PROVISIONING_FLAG_FILE), exist_ok=True)
            with open(PROVISIONING_FLAG_FILE, 'w') as f:
                f.write(datetime.utcnow().isoformat())
        except Exception as e:
            logger.error(f"Failed to write flag file: {e}")

        # Stop BLE Server and Exit
        logger.info("Shutting down agent.")
        # In a real systemd service, we might just exit and let systemd handle it, 
        # but we want to stop the BLE advertisement first.
        # self.loop.stop() # This will stop the loop
        sys.exit(0)

    async def run(self):
        self.check_already_provisioned()
        
        try:
            self.identity = DeviceIdentity()
        except Exception:
            logger.critical("Failed to load identity. Exiting.")
            sys.exit(1)

        # If already connected to Wi-Fi (e.g. ethernet or previous config), we might skip BLE?
        # Prompt says: "On boot, if no active Wi-Fi connection exists, broadcast a BLE advertisement."
        if self.nm.is_connected():
            logger.info("Network already connected. Checking if activation is needed...")
            # If we are connected but no flag file, maybe we just need the token?
            # Or maybe we should just advertise anyway to allow re-provisioning/token entry?
            # For now, we proceed to advertise to allow the app to send the token.
            pass

        self.ble_server = BLEProvisioningServer(
            self.identity.get_serial_id(),
            self.on_wifi_creds,
            self.on_token
        )
        
        logger.info("Starting BLE Server...")
        await self.ble_server.run()
        
        # Timeout Loop
        while True:
            if time.time() - self.start_time > TIMEOUT_SECONDS:
                logger.info("Provisioning window timed out. Exiting.")
                sys.exit(0)
            await asyncio.sleep(10)

if __name__ == "__main__":
    agent = ProvisioningAgent()
    try:
        asyncio.run(agent.run())
    except KeyboardInterrupt:
        pass
