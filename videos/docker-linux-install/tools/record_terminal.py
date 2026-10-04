#!/usr/bin/env python3
"""Record a real Docker install in a throwaway Ubuntu 24.04 container.

    python3 record_terminal.py <flow> out.cast     flow: apt | engine

The engine flow runs in a full Ubuntu 24.04 VM (QEMU/KVM, official cloud image,
reached over SSH) so `docker info` reports a real machine. Put the image at
vm/noble.img next to this script (see README). The apt flow uses a container.


Types at human speed into a real pty, captures every output byte with its real
timestamp, and writes an asciicast v2 file. Nothing is installed on the host.
"""
import fcntl, json, os, pty, random, re, select, struct, subprocess, sys, termios, time

NAME = "dk-tut"
COLS, ROWS = 92, 26
FLOW = sys.argv[1] if len(sys.argv) > 1 else "engine"
OUT = sys.argv[2] if len(sys.argv) > 2 else f"{FLOW}.cast"
PASSWORD = "companion"  # throwaway container user, never shown (sudo does not echo)
rng = random.Random(7)
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r")

DOCS_BLOCK = """# Add Docker's official GPG key:
sudo apt update
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update"""


def sh(*cmd, check=True):
    return subprocess.run(cmd, check=check, capture_output=True, text=True)


BASE = "dk-tut-base"
HERE = os.path.dirname(os.path.abspath(__file__))
VM = os.environ.get("VM_DIR", os.path.join(HERE, "vm"))
SSH_PORT = 2222
SESSION_CMD = None  # set by prep() / vm_prep()


def ssh_cmd(*extra):
    return ["ssh", "-q", "-p", str(SSH_PORT), "-i", os.path.join(VM, "id_ed25519"),
            "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=3", *extra, "ci@127.0.0.1"]


def vm_prep():
    """Boot a fresh Ubuntu 24.04 cloud-image VM with a user `ci` (sudo with password)."""
    global SESSION_CMD
    vm_cleanup()
    key = os.path.join(VM, "id_ed25519")
    if not os.path.exists(key):
        sh("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key)
    pub = open(key + ".pub").read().strip()
    with open(os.path.join(VM, "user-data"), "w") as f:
        f.write(f"""#cloud-config
hostname: ubuntu
manage_etc_hosts: true
users:
  - name: ci
    groups: [sudo]
    shell: /bin/bash
    lock_passwd: false
    ssh_authorized_keys: [{pub}]
chpasswd:
  expire: false
  users: [{{name: ci, password: {PASSWORD}, type: text}}]
ssh_pwauth: false
package_update: false
package_upgrade: false
timezone: America/Los_Angeles
runcmd:
  - systemctl disable --now unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer
  - touch /home/ci/.hushlogin /home/ci/.sudo_as_admin_successful
  - chown ci:ci /home/ci/.hushlogin /home/ci/.sudo_as_admin_successful
""")
    with open(os.path.join(VM, "meta-data"), "w") as f:
        f.write("instance-id: dk-tut\nlocal-hostname: ubuntu\n")
    sh("xorriso", "-as", "mkisofs", "-output", os.path.join(VM, "seed.iso"), "-volid", "cidata",
       "-joliet", "-rock", os.path.join(VM, "user-data"), os.path.join(VM, "meta-data"))
    sh("qemu-img", "create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", os.path.join(VM, "noble.img"),
       os.path.join(VM, "disk.qcow2"), "20G")
    sh("qemu-system-x86_64", "-enable-kvm", "-cpu", "host", "-smp", "4", "-m", "8192",
       "-drive", f"file={os.path.join(VM, 'disk.qcow2')},if=virtio",
       "-drive", f"file={os.path.join(VM, 'seed.iso')},if=virtio,format=raw",
       "-nic", f"user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:{SSH_PORT}-:22",
       "-display", "none", "-serial", f"file:{os.path.join(VM, 'serial.log')}",
       "-daemonize", "-pidfile", os.path.join(VM, "qemu.pid"))
    for _ in range(180):
        if subprocess.run(ssh_cmd() + ["true"], capture_output=True).returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError("VM never accepted SSH; see vm/serial.log")
    r = subprocess.run(ssh_cmd() + ["cloud-init status --wait"], capture_output=True, text=True)
    if "done" not in r.stdout:
        raise RuntimeError("cloud-init: " + r.stdout + r.stderr)
    SESSION_CMD = ["ssh", "-tt"] + ssh_cmd()[1:]


def vm_cleanup():
    pidf = os.path.join(VM, "qemu.pid")
    if os.path.exists(pidf):
        try:
            os.kill(int(open(pidf).read()), 15)
            time.sleep(2)
        except (ProcessLookupError, ValueError):
            pass
        if os.path.exists(pidf):
            os.remove(pidf)
    for f in ("disk.qcow2", "seed.iso"):
        if os.path.exists(os.path.join(VM, f)):
            os.remove(os.path.join(VM, f))


def prep():
    """A systemd Ubuntu 24.04 container with the packages a desktop install already has."""
    sh("docker", "rm", "-f", NAME, check=False)
    sh("docker", "volume", "rm", "-f", f"{NAME}-lib", f"{NAME}-ctd", check=False)
    if sh("docker", "image", "inspect", BASE, check=False).returncode != 0:
        pre = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "preinstall.txt")).read()
        sh("docker", "rm", "-f", f"{NAME}-build", check=False)
        sh("docker", "run", "-d", "--name", f"{NAME}-build", "ubuntu:24.04", "sleep", "infinity")
        sh("docker", "exec", f"{NAME}-build", "bash", "-c", f"""
set -e
export DEBIAN_FRONTEND=noninteractive
ln -fs /usr/share/zoneinfo/America/Los_Angeles /etc/localtime
apt-get update -qq
apt-get install -y -qq --no-install-recommends sudo curl ca-certificates tzdata {pre} >/dev/null
useradd -m -s /bin/bash ci
echo 'ci:{PASSWORD}' | chpasswd
usermod -aG sudo ci
touch /home/ci/.sudo_as_admin_successful && chown ci:ci /home/ci/.sudo_as_admin_successful
rm -f /usr/sbin/policy-rc.d
rm -rf /var/lib/apt/lists/*
""")
        sh("docker", "commit", "-c", 'CMD ["/sbin/init"]', f"{NAME}-build", BASE)
        sh("docker", "rm", "-f", f"{NAME}-build")
    global SESSION_CMD
    SESSION_CMD = ["docker", "exec", "-it", "-e", "TERM=xterm-256color", "-e", "USER=ci", "-e", "LOGNAME=ci",
                   "-u", "ci", "-w", "/home/ci", NAME, "bash", "-l"]
    sh("docker", "run", "-d", "--privileged", "--cgroupns=host", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw",
       "--tmpfs", "/run", "--tmpfs", "/run/lock", "--hostname", "ubuntu", "--name", NAME,
       "-v", f"{NAME}-lib:/var/lib/docker", "-v", f"{NAME}-ctd:/var/lib/containerd", BASE, "/sbin/init")
    for _ in range(60):
        r = sh("docker", "exec", NAME, "systemctl", "is-system-running", check=False)
        if r.stdout.strip() in ("running", "degraded"):
            return
        time.sleep(1)
    raise RuntimeError("systemd did not come up: " + r.stdout + r.stderr)


class Session:
    def __init__(self, prev=None):
        pid, fd = pty.fork()
        if pid == 0:
            os.environ["DOCKER_CLI_HINTS"] = "false"  # no host-side "What's next" tips on exit
            os.environ["TERM"] = "xterm-256color"
            os.execvp(SESSION_CMD[0], SESSION_CMD)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.fd, self.pid = fd, pid
        self.t0 = prev.t0 if prev else time.monotonic()
        self.events = prev.events if prev else []
        self.buf = ""
        if prev:  # a fresh login: new window contents
            self.events.append([round(self.now(), 4), "o", "\x1b[3J\x1b[H\x1b[2J"])

    def mark(self, label):
        self.events.append([round(self.now(), 4), "m", label])

    def now(self):
        return time.monotonic() - self.t0

    def pump(self, seconds):
        end = time.monotonic() + seconds
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return
            r, _, _ = select.select([self.fd], [], [], min(left, 0.05))
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                if data:
                    s = data.decode("utf-8", "replace")
                    self.events.append([round(self.now(), 4), "o", s])
                    self.buf = (self.buf + s)[-4000:]

    def wait_for(self, pattern, timeout=600):
        end = time.monotonic() + timeout
        rx = re.compile(pattern)
        while time.monotonic() < end:
            if rx.search(ANSI.sub("", self.buf)):
                self.buf = ""
                return
            self.pump(0.05)
        with open("debug.cast", "w") as f:
            for e in self.events:
                f.write(json.dumps(e) + "\n")
        raise TimeoutError(f"{pattern!r}; tail: {ANSI.sub('', self.buf)[-400:]!r}")

    def prompt(self, timeout=90):
        self.wait_for(r"ci@ubuntu:~\$ $", timeout)

    def type(self, text):
        for i, ch in enumerate(text):
            os.write(self.fd, ch.encode())
            d = rng.uniform(0.055, 0.15)
            if ch == " ":
                d += rng.uniform(0.03, 0.12)
            if ch in "-/." and rng.random() < 0.3:
                d += rng.uniform(0.05, 0.2)
            if rng.random() < 0.03:
                d += rng.uniform(0.25, 0.5)  # brief hesitation
            self.pump(d)

    def enter(self):
        os.write(self.fd, b"\r")
        self.pump(0.05)

    def paste(self, text):
        os.write(self.fd, b"\x1b[200~" + text.encode() + b"\x1b[201~")
        self.pump(0.4)


def flow_apt():
    prep()
    s = Session()
    s.prompt()
    s.pump(1.2)

    # 1. Refresh package lists; first sudo asks for the password.
    s.type("sudo apt update")
    s.pump(0.35); s.enter()
    s.wait_for(r"\[sudo\] password for ci: $")
    s.pump(0.9)
    s.type(PASSWORD); s.pump(0.25); s.enter()
    s.prompt(); s.pump(1.6)

    # 2. Paste the block copied from docs.docker.com.
    s.paste(DOCS_BLOCK)
    s.pump(0.6); s.enter()
    s.prompt(); s.pump(1.8)

    # 3. Install Docker Engine.
    s.type("sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin")
    s.pump(0.4); s.enter()
    s.wait_for(r"\[Y/n\] $", timeout=120)
    s.pump(1.3)
    s.type("y"); s.pump(0.2); s.enter()
    s.prompt(timeout=600)

    s.pump(1.8)

    # 4. Verify.
    s.type("sudo docker run hello-world")
    s.pump(0.4); s.enter()
    s.wait_for(r"docs\.docker\.com/get-started/", timeout=180)
    s.prompt()
    s.pump(3.0)

    return s


def flow_engine():
    """docs.ci.computer -> Install Docker Engine (Linux), then docker info and compose."""
    vm_prep()
    s = Session()
    s.prompt()
    s.pump(1.2)

    s.mark("install")
    s.paste("curl -fsSL https://get.docker.com | sh")
    s.pump(0.6); s.enter()
    s.wait_for(r"\[sudo\] password for ci: $", timeout=120)
    s.pump(0.9)
    s.type(PASSWORD); s.pump(0.25); s.enter()
    s.prompt(timeout=600); s.pump(1.8)

    s.mark("group")
    s.type("sudo usermod -aG docker $USER")
    s.pump(0.4); s.enter()
    s.prompt(); s.pump(1.5)
    s.type("exit"); s.pump(0.3); s.enter()
    s.pump(1.0)

    # Log out and back in: a new login session picks up the docker group.
    s = Session(prev=s)
    s.mark("relogin")
    s.prompt(); s.pump(1.4)

    s.mark("info")
    s.type("docker info"); s.pump(0.4); s.enter()
    s.prompt(); s.pump(2.2)

    s.mark("compose")
    s.type("docker compose version"); s.pump(0.4); s.enter()
    s.prompt(); s.pump(3.0)
    return s


def main():
    s = {"apt": flow_apt, "engine": flow_engine}[FLOW]()
    if FLOW == "engine":
        vm_cleanup()
    header = {"version": 2, "width": COLS, "height": ROWS, "timestamp": int(time.time()),
              "env": {"TERM": "xterm-256color", "SHELL": "/bin/bash"}}
    with open(OUT, "w") as f:
        f.write(json.dumps(header) + "\n")
        for e in sorted(s.events, key=lambda e: e[0]):
            f.write(json.dumps(e) + "\n")
    print(f"wrote {OUT}: {len(s.events)} events, {s.events[-1][0]:.1f}s")


if __name__ == "__main__":
    try:
        main()
    finally:
        vm_cleanup()
        sh("docker", "rm", "-f", NAME, check=False)
        sh("docker", "volume", "rm", "-f", f"{NAME}-lib", f"{NAME}-ctd", check=False)
