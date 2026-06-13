{ pkgs ? import <nixpkgs> {} }:

pkgs.appimageTools.wrapType2 rec {
  pname = "companion-hub";
  version = "0.2.4";

  src = pkgs.fetchurl {
    url = "https://github.com/companionintelligence/CI-Hub/releases/download/v${version}/Companion.Hub_${version}_amd64.AppImage";
    # TODO: replace with actual sha256 of the AppImage release asset
    # Run: nix-prefetch-url <url>  or  nix hash file --type sha256 <downloaded-file>
    sha256 = "sha256-PLACEHOLDER_SHA256_APPIMAGE_AMD64=";
  };

  extraInstallCommands = ''
    install -Dm644 /dev/stdin $out/share/applications/companion-hub.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Companion Hub
Exec=companion-hub
Icon=companion-hub
Categories=Utility;
EOF
  '';

  meta = with pkgs.lib; {
    description = "AI-powered companion intelligence hub";
    longDescription = ''
      Companion Hub is a desktop application that serves as an AI-powered companion
      intelligence hub, orchestrating AI workflows, integrations, and local services
      for the Companion Intelligence platform. It manages Docker Compose stacks,
      coordinates local AI services, and provides a unified interface for the
      companion intelligence ecosystem.
    '';
    homepage = "https://github.com/companionintelligence/CI-Hub";
    license = {
      shortName = "CI-Commercial-1.0";
      fullName = "Commercial Standard License";
      free = false;
    };
    platforms = [ "x86_64-linux" ];
    maintainers = [];
    mainProgram = "companion-hub";
  };
}