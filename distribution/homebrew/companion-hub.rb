# Homebrew Cask formula for Companion Hub
# Published via: https://github.com/companionintelligence/homebrew-tap

cask "companion-hub" do
  version "0.3.13"

  on_intel do
    url "https://dl.ci.computer/v#{version}/macos/intel/Companion%20Hub_#{version}_x64.dmg"
    sha256 "2f495e70ac9f989ba53838bc4d2adeca1088d916733d327348179e2f95a843ac"
  end

  on_arm do
    url "https://dl.ci.computer/v#{version}/macos/arm/Companion%20Hub_#{version}_aarch64.dmg"
    sha256 "0361c56f6213ac180dea10220ec21fadb4eff5541147b329f0367aabc0564759"
  end

  name "Companion Hub"
  desc "Self-hosted app platform and local AI hub from Companion Intelligence"
  homepage "https://ci.computer/hub"

  # latest.json is {"version":"v0.3.13","date":"..."}. It only moves to a version once that
  # release has an installer for every platform, so a version seen here is fully published.
  livecheck do
    url "https://dl.ci.computer/latest.json"
    strategy :json do |json|
      json["version"]&.delete_prefix("v")
    end
  end

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
