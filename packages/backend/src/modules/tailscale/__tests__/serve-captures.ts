/**
 * Tailscale CLI output captured from fleet appliances on 2026-09-17, kept byte-for-byte unless a
 * constant says it is derived.
 *
 * The Hub's serve-status parser was written against a hand-made fixture that left out the
 * `Handlers` level, and its tests passed while every appliance re-ran `tailscale serve` every five
 * minutes. Tests that describe the CLI's output read it from here instead.
 */

/** `tailscale serve status --json` on core-6 (Tailscale 1.98.2), serving the host-mode Hub on `API_PORT=5002`. */
export const CORE_6_SERVE_STATUS = `{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "core-6.capybara-ulmer.ts.net:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://localhost:5002"
        }
      }
    }
  }
}`;

/**
 * `tailscale serve status --json` on core-17 (Tailscale 1.102.3) after its rename from bench-1
 * and an operator's manual `tailscale serve` under the new name. The `bench-1` listener is left
 * over from before the rename; until the second listener was added, peers' TLS to core-17 failed.
 */
export const CORE_17_SERVE_STATUS_AFTER_MANUAL_REPAIR = `{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "bench-1.capybara-ulmer.ts.net:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://localhost:5002"
        }
      }
    },
    "core-17.capybara-ulmer.ts.net:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://localhost:5002"
        }
      }
    }
  }
}`;

/**
 * core-17 as it stood between the rename and the manual repair: the same capture without the
 * `core-17` listener.
 */
export const CORE_17_SERVE_STATUS_BEFORE_REPAIR = `{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "bench-1.capybara-ulmer.ts.net:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://localhost:5002"
        }
      }
    }
  }
}`;

/** `tailscale serve status --json` on fzzy (Tailscale 1.102.4) on 2026-09-19: the host-mode Hub alone. */
export const FZZY_SERVE_STATUS = `{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "fzzy.capybara-ulmer.ts.net:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://localhost:5002"
        }
      }
    }
  }
}`;

/**
 * Derived: fzzy after `sudo tailscale serve --bg --https 3081 http://127.0.0.1:3081` for a game
 * container the Hub does not manage. The Hub's sync removed that listener 84 seconds later.
 */
export const FZZY_SERVE_STATUS_WITH_MANUAL_3081 = `{
  "TCP": {
    "443": {
      "HTTPS": true
    },
    "3081": {
      "HTTPS": true
    }
  },
  "Web": {
    "fzzy.capybara-ulmer.ts.net:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://localhost:5002"
        }
      }
    },
    "fzzy.capybara-ulmer.ts.net:3081": {
      "Handlers": {
        "/": {
          "Proxy": "http://127.0.0.1:3081"
        }
      }
    }
  }
}`;

/** The command the Hub runs to publish itself in host mode on those appliances. */
export const HUB_SERVE_COMMAND = '/usr/bin/tailscale serve --bg --yes --https=443 http://localhost:5002';

/**
 * stderr of that command on beta-ms-a2 (Tailscale 1.102.3), where the Hub runs as uid 1000 and the
 * host never ran `tailscale set --operator`. It was logged every five minutes.
 */
export const SERVE_CONFIG_DENIED_STDERR = `sending serve config: Access denied: serve config denied

Use 'sudo tailscale serve --bg --yes --https=443 http://localhost:5002'.
To not require root, use 'sudo tailscale set --operator=$USER' once.
`;
