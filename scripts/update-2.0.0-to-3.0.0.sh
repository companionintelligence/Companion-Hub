#!/usr/bin/env bash
set -o errexit
set -o nounset
set -o pipefail

ARCHITECTURE="$(uname -m)"

ASSET="runcihub-cli-linux-x86_64.tar.gz"
if [[ "$ARCHITECTURE" == "arm64" || "$ARCHITECTURE" == "aarch64" ]]; then
  ASSET="runcihub-cli-linux-aarch64.tar.gz"
fi

URL="https://github.com/runcihub/runcihub/releases/download/v3.0.3/$ASSET"

rm -f ./runcihub-cli

if [[ "$ASSET" == *".tar.gz" ]]; then
  curl --location "$URL" -o ./runcihub-cli.tar.gz
  tar -xzf ./runcihub-cli.tar.gz

  asset_name=$(tar -tzf ./runcihub-cli.tar.gz | head -n 1 | cut -f1 -d"/")
  mv "./${asset_name}" ./runcihub-cli
  rm ./runcihub-cli.tar.gz
else
  curl --location "$URL" -o ./runcihub-cli
fi

chmod +x ./runcihub-cli
sudo ./runcihub-cli start
