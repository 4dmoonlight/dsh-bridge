#!/usr/bin/env bash
# Install the release poller separately from the running Hub. Does not restart it.
set -euo pipefail

usage() { echo 'Usage: sudo bash scripts/install-server-release-pull.sh /absolute/release.json [--enable]' >&2; exit 2; }
[[ $# == 1 || $# == 2 ]] || usage
enable=no
if [[ $# == 2 ]]; then [[ $2 == --enable ]] || usage; enable=yes; fi
[[ $EUID == 0 ]] || usage
source_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
config=$1
[[ $config == /* && -f $config && ! -L $config && $(realpath -- "$config") == "$config" ]] || usage

lib=/usr/local/lib/dsh-bridge-release
sys=/etc/systemd/system
state=/var/lib/dsh-bridge-release
root=/opt/dsh-bridge-rollouts
releases="$root/releases"
unit=dsh-bridge.service
systemctl is-active --quiet "$unit" || { echo 'The existing Hub must already be running.' >&2; exit 1; }
[[ $(systemctl show "$unit" -p User --value) == hub ]] || { echo 'The Hub unit must run as the unprivileged hub user.' >&2; exit 1; }
/usr/bin/python3 -m json.tool "$config" >/dev/null

# Refuse to overwrite a different installation or touch the existing Hub unit,
# OAuth configuration, certificates, or data. Re-running identical files is safe.
for name in pull-server-release.py dsh-bridge-release.service dsh-bridge-release.timer; do
  [[ -f $source_dir/$name && ! -L $source_dir/$name ]] || { echo 'Missing release-puller installation file.' >&2; exit 1; }
done
ensure_dir() {
  local dst=$1 mode=$2
  [[ ! -L $dst ]] || { echo "Refusing linked release directory: $dst" >&2; exit 1; }
  if [[ ! -e $dst ]]; then install -d -o root -g root -m "$mode" -- "$dst"; fi
  [[ -d $dst && $(realpath -- "$dst") == "$dst" && $(stat -c %U -- "$dst") == root ]] || { echo "Unsafe release directory: $dst" >&2; exit 1; }
  local bits; bits=$(stat -c %a -- "$dst")
  (( (8#$bits & 8#022) == 0 )) || { echo "Untrusted writers for release directory: $dst" >&2; exit 1; }
}
for d in /etc/dsh-bridge "$sys" "$lib" "$root" "$releases" "$sys/$unit.d"; do ensure_dir "$d" 0755; done
ensure_dir "$state" 0700
install_file() {
  local src=$1 dst=$2 mode=$3
  [[ ! -L $dst ]] || { echo 'Refusing to replace a symbolic link.' >&2; exit 1; }
  if [[ -e $dst ]]; then
    [[ -f $dst && $(realpath -- "$dst") == "$dst" && $(stat -c %U -- "$dst") == root &&
       $(stat -c %a -- "$dst") == "$(printf '%o' "$((8#$mode))")" ]] || { echo "Unsafe release-puller file: $dst" >&2; exit 1; }
    cmp -s -- "$src" "$dst" || { echo "Refusing to overwrite different release-puller installation file: $dst" >&2; exit 1; }
  else
    install -o root -g root -m "$mode" -- "$src" "$dst"
  fi
}
install_file "$config" /etc/dsh-bridge/release.json 0600
install_file "$source_dir/pull-server-release.py" "$lib/pull-server-release.py" 0644
install_file "$source_dir/dsh-bridge-release.service" "$sys/dsh-bridge-release.service" 0644
install_file "$source_dir/dsh-bridge-release.timer" "$sys/dsh-bridge-release.timer" 0644
systemd-analyze verify "$sys/dsh-bridge-release.service" "$sys/dsh-bridge-release.timer"
systemctl daemon-reload
if [[ $enable == yes ]]; then systemctl enable --now dsh-bridge-release.timer; fi
printf '%s\n' 'Release puller installed; existing Hub was not restarted by the installer.'
