# Homebrew Cask formula for Companion Hub
# Published via: https://github.com/companionintelligence/homebrew-tap

cask "companion-hub" do
  version "0.2.55"

  on_intel do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_x64.dmg"
    sha256 "f8f2ab0eb55f5c78e896a0e4acf0b35c3f7d8fe2313a505046c2e06a7a0d007c"
  end

  on_arm do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_aarch64.dmg"
    sha256 "86ac5349ecbde8398636bef3bc93825f2d0722dcda097dea0808fbf80f0f6078"
  end

  name "Companion Hub"
  desc "Self-hosted app platform and local AI hub from Companion Intelligence"
  homepage "https://ci.computer/hub"

  app "Companion Hub.app"

  zap trash: [
    "~/Library/Application Support/computer.ci.app.hub",
    "~/Library/Caches/computer.ci.app.hub",
    "~/Library/Preferences/computer.ci.app.hub.plist",
    "~/Library/Saved Application State/computer.ci.app.hub.savedState",
    "~/Library/WebKit/computer.ci.app.hub",
  ]
end
