# Companion Hub for Nix on Linux. Unpacks the upstream .deb (0.3.10 ships no AppImage)
# and patches its ELF files against Nix store libraries.
#
# Not built yet: this was written without a Nix toolchain. Before merging, run
#   nix build -f distribution/nix/default.nix
# on an x86_64-linux or aarch64-linux machine.
{ pkgs ? import <nixpkgs> { } }:

let
  version = "0.3.10";
  releases = {
    x86_64-linux = {
      file = "Companion.Hub_${version}_amd64.deb";
      sha256 = "38e04432b4fd80c0bea4658bda8dd4c5ac9637c6859a2c8e0e33f77becbf2f01";
    };
    aarch64-linux = {
      file = "Companion.Hub_${version}_arm64.deb";
      sha256 = "495bd13a2d9c0d2bce7b1abc5289c8827480e27be926f4006007e9278b8713d0";
    };
  };
  release = releases.${pkgs.stdenv.hostPlatform.system}
    or (throw "companion-hub ${version} has no Linux build for ${pkgs.stdenv.hostPlatform.system}");
in
pkgs.stdenv.mkDerivation {
  pname = "companion-hub";
  inherit version;

  src = pkgs.fetchurl {
    url = "https://github.com/companionintelligence/Companion-Hub/releases/download/v${version}/${release.file}";
    sha256 = release.sha256;
  };

  dontUnpack = true;

  nativeBuildInputs = [
    pkgs.dpkg
    pkgs.autoPatchelfHook
    pkgs.wrapGAppsHook3
  ];

  buildInputs = [
    pkgs.gtk3
    pkgs.webkitgtk_4_1
    pkgs.libayatana-appindicator
    pkgs.openssl
  ];

  installPhase = ''
    runHook preInstall
    dpkg-deb -x "$src" unpacked
    mkdir -p "$out"
    cp -r unpacked/usr/. "$out/"
    runHook postInstall
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
    homepage = "https://github.com/companionintelligence/Companion-Hub";
    # Owner decision: snapcraft.yaml says AGPL-3.0-only, while the AUR and Scoop
    # packages say CI-Commercial-1.0. This expression keeps CI-Commercial-1.0.
    license = {
      shortName = "CI-Commercial-1.0";
      fullName = "Commercial Standard License";
      free = false;
    };
    platforms = builtins.attrNames releases;
    maintainers = [ ];
    mainProgram = "companion-hub";
  };
}
