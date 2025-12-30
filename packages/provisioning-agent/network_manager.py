import subprocess
import logging
import time

logger = logging.getLogger(__name__)

class NetworkManager:
    def __init__(self):
        pass

    def is_connected(self) -> bool:
        """Checks if the device has an active connection."""
        try:
            # Check for full connectivity
            result = subprocess.run(
                ["nmcli", "-t", "-f", "STATE", "general"],
                capture_output=True,
                text=True,
                check=True
            )
            state = result.stdout.strip()
            return state == "connected"
        except subprocess.CalledProcessError:
            return False

    def connect_wifi(self, ssid: str, password: str) -> bool:
        """Attempts to connect to a Wi-Fi network."""
        logger.info(f"Attempting to connect to Wi-Fi: {ssid}")
        
        try:
            # First, try to add/connect
            # nmcli device wifi connect "$SSID" password "$PASSWORD"
            cmd = ["nmcli", "device", "wifi", "connect", ssid, "password", password]
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True
            )
            
            if result.returncode == 0:
                logger.info(f"Successfully connected to {ssid}")
                return True
            else:
                logger.error(f"Failed to connect to {ssid}: {result.stderr}")
                return False
                
        except Exception as e:
            logger.error(f"Exception during Wi-Fi connection: {e}")
            return False

    def get_active_connection_info(self):
        """Returns details about the active connection."""
        try:
            result = subprocess.run(
                ["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"],
                capture_output=True,
                text=True
            )
            return result.stdout.strip()
        except Exception:
            return None
