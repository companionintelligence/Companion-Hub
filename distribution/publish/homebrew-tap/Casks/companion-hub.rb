# Homebrew Cask formula for Companion Hub
# Published via: https://github.com/companionintelligence/homebrew-tap

cask "companion-hub" do
  version "0.2.28"

  on_intel do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_x64.dmg"
    sha256 "0277577f6a43732186dead233e7511bd285421c655e360a0f50370e5bbc73062"
  end

  on_arm do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v\#{version}/Companion.Hub_\#{version}_aarch64.dmg"
    sha256 "04c874602846e7bacdd2caabe35f1568e4954f0267b3105592dadc54476abda2"
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
