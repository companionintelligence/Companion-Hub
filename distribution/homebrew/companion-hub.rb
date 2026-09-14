# Homebrew Cask formula for Companion Hub
# Published via: https://github.com/companionintelligence/homebrew-tap

cask "companion-hub" do
  version "0.2.70"

  on_intel do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_x64.dmg"
    sha256 "4e4cb7eef1d21ba3fe076edbaa15ff348f5affe543aab9ae40817e30c54ffaa7"
  end

  on_arm do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_aarch64.dmg"
    sha256 "f73449dd56bbc1ed383600418f0d39eefc1cd4884de4803ec2a239ca2e27ff6d"
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
