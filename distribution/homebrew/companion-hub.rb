# Homebrew Cask formula for Companion Hub
# Submit to: https://github.com/Homebrew/homebrew-cask or maintain own tap at companionintelligence/homebrew-tap

cask "companion-hub" do
  version "0.2.4"

  on_intel do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_x64.dmg"
    # TODO: sha256 of release asset (Companion.Hub_0.2.4_x64.dmg)
    sha256 "PLACEHOLDER_SHA256_X64"
  end

  on_arm do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_aarch64.dmg"
    # TODO: sha256 of release asset (Companion.Hub_0.2.4_aarch64.dmg)
    sha256 "PLACEHOLDER_SHA256_AARCH64"
  end

  name "Companion Hub"
  desc "AI-powered companion intelligence hub"
  homepage "https://github.com/companionintelligence/CI-Hub"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Companion Hub.app"

  zap trash: [
    "~/Library/Application Support/computer.ci.app.hub",
    "~/Library/Caches/computer.ci.app.hub",
    "~/Library/Preferences/computer.ci.app.hub.plist",
    "~/Library/Saved Application State/computer.ci.app.hub.savedState",
    "~/Library/WebKit/computer.ci.app.hub",
  ]
end