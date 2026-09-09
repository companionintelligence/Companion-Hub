#!/usr/bin/env bash
set -o errexit
set -o nounset
set -o pipefail

echo "Installing Companion Home..."

ARCHITECTURE="$(uname -m)"
# Not supported on 32 bits systems
if [[ "$ARCHITECTURE" == "armv7"* ]] || [[ "$ARCHITECTURE" == "i686" ]] || [[ "$ARCHITECTURE" == "i386" ]]; then
  echo "Companion Home is not supported on 32-bit systems"
  exit 1
fi

### --------------------------------
### CLI arguments
### --------------------------------
UPDATE="false"
VERSION="latest"
ASSET="cihub-linux-x64"
ENV_FILE=""

while [ -n "${1-}" ]; do
  case "$1" in
  --update) UPDATE="true" ;;
  --version)
    shift        # Move to the next parameter
    VERSION="$1" # Assign the value to VERSION
    if [ -z "$VERSION" ]; then
      echo "Option --version requires a value" && exit 1
    fi
    ;;
  --asset)
    shift      # Move to the next parameter
    ASSET="$1" # Assign the value to ASSET
    if [ -z "$ASSET" ]; then
      echo "Option --asset requires a value" && exit 1
    fi
    ;;
  --env-file)
    shift         # Move to the next parameter
    ENV_FILE="$1" # Assign the value to ENV_FILE
    if [ -z "$ENV_FILE" ]; then
      echo "Option --env-file requires a value" && exit 1
    fi
    ;;
  --)
    shift # The double dash makes them parameters
    break
    ;;
  *) echo "Option $1 not recognized" && exit 1 ;;
  esac
  shift
done

OS="$(cat $(ls -p /etc | grep -v / | grep "[A-Za-z]*[_-][rv]e[lr]" | awk '{print "/etc/" $1}') | grep "^ID=" | cut -d= -f2 | uniq | tr '[:upper:]' '[:lower:]' | tr -d '"')"
SUB_OS="$(cat $(ls -p /etc | grep -v / | grep "[A-Za-z]*[_-][rv]e[lr]" | awk '{print "/etc/" $1}') | grep "^ID_LIKE=" | cut -d= -f2 | uniq | tr '[:upper:]' '[:lower:]' | tr -d '"' || echo 'unknown')"

function install_generic() {
  local dependency="${1}"
  local os="${2}"

  if [[ "${os}" == "debian" ]]; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${dependency}"
    return 0
  elif [[ "${os}" == "ubuntu" || "${os}" == "pop" ]]; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${dependency}"
    return 0
  elif [[ "${os}" == "centos" ]]; then
    sudo yum install -y --allowerasing "${dependency}"
    return 0
  elif [[ "${os}" == "rocky" ]]; then
    sudo dnf -y install "${dependency}"
    return 0
  elif [[ "${os}" == "fedora" ]]; then
    sudo dnf -y install "${dependency}"
    return 0
  elif [[ "${os}" == "arch" || "${os}" == "manjaro" ]]; then
    if ! sudo pacman -Sy --noconfirm "${dependency}"; then
      if command -v yay >/dev/null 2>&1; then
        sudo -u "$SUDO_USER" yay -Sy --noconfirm "${dependency}"
      else
        echo "Could not install \"${dependency}\", either using pacman or the yay AUR helper. Please try installing it manually."
        return 1
      fi
    fi
    return 0

  else
    return 1
  fi
}

function install_docker() {
  local os="${1}"
  echo "Installing docker for os ${os}"
  echo "Your sudo password might be asked to install docker"

  if [[ "${os}" == "debian" ]]; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg lsb-release
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    return 0
  elif [[ "${os}" == "ubuntu" || "${os}" == "pop" ]]; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg lsb-release
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    return 0
  elif [[ "${os}" == "centos" || "${os}" == "rocky" ]]; then # accurate as of Rocky Linux 9 and CentOS Stream 10 as they still use DNF4
    sudo dnf4 -y install dnf-plugins-core
    sudo dnf4 config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    sudo dnf4 -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
    sudo systemctl start docker
    sudo systemctl enable docker
    return 0
  elif [[ "${os}" == "fedora" ]]; then
    sudo dnf5 -y install dnf5-plugins
    sudo dnf5 config-manager addrepo --from-repofile="https://download.docker.com/linux/fedora/docker-ce.repo"
    sudo dnf5 -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
    sudo systemctl start docker
    sudo systemctl enable docker
    return 0
  elif [[ "${os}" == "arch" || "${os}" == "manjaro" ]]; then
    sudo pacman -Sy --noconfirm docker docker-compose
    sudo systemctl start docker.service
    sudo systemctl enable docker.service
    return 0
  else
    return 1
  fi
}

if ! command -v docker >/dev/null; then
  echo "Installing docker"
  install_docker "${OS}"
  docker_result=$?

  if [[ docker_result -ne 0 ]]; then
    echo "Your system ${OS} is not supported trying with sub_os ${SUB_OS}"
    install_docker "${SUB_OS}"
    docker_sub_result=$?

    if [[ docker_sub_result -ne 0 ]]; then
      echo "Your system ${SUB_OS} is not supported please install docker manually"
      exit 1
    fi
  fi
fi

# If docker -v is lower than 28.0.0 it will be updated
if [[ "$(docker -v | cut -d' ' -f3 | cut -d',' -f1)" < "28.0.0" ]]; then
  echo "Updating docker"
  install_docker "${OS}"
  docker_result=$?

  if [[ docker_result -ne 0 ]]; then
    echo "Your system ${OS} is not supported trying with sub_os ${SUB_OS}"
    install_docker "${SUB_OS}"
    docker_sub_result=$?

    if [[ docker_sub_result -ne 0 ]]; then
      echo "Your system ${SUB_OS} is not supported please install docker manually"
      exit 1
    fi
  fi
fi

function check_dependency_and_install() {
  local dependency="${1}"

  if ! command -v "${dependency}" >/dev/null; then
    echo "Installing ${dependency}"
    install_generic "${dependency}" "${OS}"
    install_result=$?

    if [[ install_result -eq 0 ]]; then
      echo "${dependency} installed"
    else
      echo "Your system ${OS} is not supported trying with sub_os ${SUB_OS}"
      install_generic "${dependency}" "${SUB_OS}"
      install_sub_result=$?

      if [[ install_sub_result -eq 0 ]]; then
        echo "${dependency} installed"
      else
        echo "Your system ${SUB_OS} is not supported please install ${dependency} manually"
        exit 1
      fi
    fi
  fi
}

# Example
# check_dependency_and_install "openssl"

# If version was not given it will install the latest version
if [[ "${VERSION}" == "latest" ]]; then
  LATEST_VERSION=$(curl -sL https://api.github.com/repos/companionintelligence/CI-Hub/releases/latest | grep tag_name | cut -d '"' -f4)
  VERSION="${LATEST_VERSION}"
fi

if [[ "$ARCHITECTURE" == "arm64" || "$ARCHITECTURE" == "aarch64" ]]; then
  ASSET="cihub-linux-arm64"
fi

URL="https://github.com/companionintelligence/CI-Hub/releases/download/$VERSION/$ASSET"

if [[ "${UPDATE}" == "false" ]]; then
  mkdir -p cihub-install
  cd cihub-install || exit
fi

# The release asset is a standalone executable, not a tarball. It used to be
# `runcihub-cli-linux-x86_64.tar.gz` from the retired CI-OS-Hub repo — an asset no workflow has ever
# produced, so this download 404'd for as long as the script has existed.
echo "Downloading ${ASSET} from ${URL}"
curl --fail --location "$URL" -o ./cihub
chmod +x ./cihub

# `cihub up` replaces `start`, which was removed and now prints a "command removed" box and exits 2.
# `--env-file` was never a cihub flag either.
#
# The appliance seed needs a Postgres password and there is no terminal here to prompt for one, so it
# has to arrive in the environment; `sudo -E` is what carries it across the privilege boundary.
if [[ -z "${CIHUB_POSTGRES_PASSWORD:-}${POSTGRES_PASSWORD:-}" ]]; then
  echo "Set CIHUB_POSTGRES_PASSWORD (at least 8 characters) before running this script." >&2
  echo "  CIHUB_POSTGRES_PASSWORD=... ./install.sh" >&2
  exit 1
fi

sudo -E ./cihub up --detached
