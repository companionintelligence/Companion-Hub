# Homebrew Cask formula for Companion Hub
# Published via: https://github.com/companionintelligence/homebrew-tap

cask "companion-hub" do
  version "0.3.16"

  on_intel do
    url "https://dl.ci.computer/v#{version}/macos/intel/Companion%20Hub_#{version}_x64.dmg"
    sha256 "e8947ec2902c918108c98b53f253fe0f1bd743152d4dbe4b9004d9fe99b83ecd"
  end

  on_arm do
    url "https://dl.ci.computer/v#{version}/macos/arm/Companion%20Hub_#{version}_aarch64.dmg"
    sha256 "4c1153534626eae3d0b413096dc649e8dd0576cf7082522aaf5b646fb6195b52"
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
