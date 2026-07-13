# Homebrew Cask formula for Companion Hub
# Published via: https://github.com/companionintelligence/homebrew-tap

cask "companion-hub" do
  version "0.2.41"

  on_intel do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_x64.dmg"
    sha256 "7dd5e7768f3e678ab708b0ce201eb283a08ae56de8042be9b1d80689668d7970"
  end

  on_arm do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_aarch64.dmg"
    sha256 "0a65c59d857e35ebffed7064028f7b7f03c4337c17c797fd28da50517849fc26"
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
