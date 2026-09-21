# Homebrew Cask formula for Companion Hub
# Published via: https://github.com/companionintelligence/homebrew-tap

cask "companion-hub" do
  version "0.2.73"

  on_intel do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_x64.dmg"
    sha256 "8731bd7db9275556c2094e6299ec2c6285421c2ad867ea5173dc8cc6c7ede549"
  end

  on_arm do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_aarch64.dmg"
    sha256 "2cba3c7bac9b589667fed38cc8a1162ca06901206972f36de9d7f40272b24d1f"
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
