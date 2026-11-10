# Homebrew Cask formula for Companion Hub
# Published via: https://github.com/companionintelligence/homebrew-tap

cask "companion-hub" do
  version "0.3.10"

  on_intel do
    url "https://github.com/companionintelligence/Companion-Hub/releases/download/v#{version}/Companion.Hub_#{version}_x64.dmg"
    sha256 "b48dcd18684835c745c4019b224a3eb2101c2a98b7093a45031b6899b631a99d"
  end

  on_arm do
    url "https://github.com/companionintelligence/Companion-Hub/releases/download/v#{version}/Companion.Hub_#{version}_aarch64.dmg"
    sha256 "a721c7f4d3f3cf9f1c7a0d4ea1e5040361e3b3c8f23dfb6459b9b7a18697a859"
  end

  name "Companion Hub"
  desc "Self-hosted app platform and local AI hub from Companion Intelligence"
  homepage "https://ci.computer/hub"

  app "Companion Hub.app"

  # The desktop keeps its data in Application Support/companion-hub and its Cloudflare
  # tunnel token in Application Support/tunnel, beside the data folder. "tunnel" is a
  # generic name, so zap trashes only the files the Hub writes there and removes the
  # folder (and the empty certs folder the Hub creates) only when nothing else is left.
  zap trash: [
        "~/Library/Application Support/companion-hub",
        "~/Library/Application Support/computer.ci.app.hub",
        "~/Library/Application Support/tunnel/.user-cleared-token",
        "~/Library/Application Support/tunnel/leftover.json",
        "~/Library/Application Support/tunnel/registration.json",
        "~/Library/Application Support/tunnel/token",
        "~/Library/Caches/computer.ci.app.hub",
        "~/Library/Preferences/computer.ci.app.hub.plist",
        "~/Library/Saved Application State/computer.ci.app.hub.savedState",
        "~/Library/WebKit/computer.ci.app.hub",
      ],
      rmdir: "~/Library/Application Support/tunnel"
end
