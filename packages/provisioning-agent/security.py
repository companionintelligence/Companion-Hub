import json
import hmac
import hashlib
import os
import logging

# Default path, can be overridden for testing
IDENTITY_FILE = os.getenv("DEVICE_IDENTITY_FILE", "/etc/device_identity.json")

logger = logging.getLogger(__name__)

class DeviceIdentity:
    def __init__(self):
        self.serial_id = None
        self.device_secret = None
        self.load_identity()

    def load_identity(self):
        """Loads the SERIAL_ID and DEVICE_SECRET from the JSON file."""
        if not os.path.exists(IDENTITY_FILE):
            logger.error(f"Identity file not found at {IDENTITY_FILE}")
            raise FileNotFoundError(f"Identity file not found at {IDENTITY_FILE}")

        try:
            with open(IDENTITY_FILE, 'r') as f:
                data = json.load(f)
                self.serial_id = data.get("SERIAL_ID")
                self.device_secret = data.get("DEVICE_SECRET")
                
                if not self.serial_id or not self.device_secret:
                    raise ValueError("Missing SERIAL_ID or DEVICE_SECRET in identity file")
            
            logger.info(f"Loaded identity for device: {self.serial_id}")
                    
        except Exception as e:
            logger.error(f"Failed to load device identity: {e}")
            raise

    def sign_payload(self, timestamp: str) -> str:
        """
        Generates an HMAC-SHA256 signature using the DEVICE_SECRET.
        The message signed is '{SERIAL_ID}:{timestamp}'.
        """
        if not self.device_secret:
            raise ValueError("Device secret not loaded")
            
        # Construct the message to sign. 
        # Ensuring consistency with the server-side verification logic.
        message = f"{self.serial_id}:{timestamp}"
        
        signature = hmac.new(
            self.device_secret.encode('utf-8'),
            message.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        
        return signature

    def get_serial_id(self):
        return self.serial_id
