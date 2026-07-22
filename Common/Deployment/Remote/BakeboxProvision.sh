#!/usr/bin/env bash
#
# Runs ON the throwaway Debian 12 bakebox (as root), pushed there by deploy.sh.
# Implements Deployment.md §1.10 steps: build the worker image, install the worker
# systemd unit, then trim the OS + containerd cache so the disk fits Linode's 6 GB
# Image cap. deploy.sh handles power-off, disk shrink and capture afterwards from
# the dev box via the API.
#
# Expects /root/agent-context.tar.gz (the Agent/ build context) to already be present.
set -euo pipefail

AGENT_CONTEXT_ARCHIVE="/root/agent-context.tar.gz"
REPOSITORY_DIRECTORY="/root/CogniumLearn"
MAXIMUM_USED_KILOBYTES=5662310   # 5.4 GB — Linode's "< 5.4 GB used" capture limit.

echo "==> Installing Docker (Debian 12)..."
if ! command -v docker >/dev/null 2>&1
then
    curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "==> Unpacking the Agent build context..."
[ -f "$AGENT_CONTEXT_ARCHIVE" ] || { echo "ERROR: $AGENT_CONTEXT_ARCHIVE not found"; exit 1; }
rm -rf "$REPOSITORY_DIRECTORY"
mkdir -p "$REPOSITORY_DIRECTORY"
tar -xzf "$AGENT_CONTEXT_ARCHIVE" -C "$REPOSITORY_DIRECTORY"
rm -f "$AGENT_CONTEXT_ARCHIVE"

echo "==> Building the cogniumlearn-agent image..."
cd "$REPOSITORY_DIRECTORY/Agent"
docker build -t cogniumlearn-agent -f Dockerfile .
docker images cogniumlearn-agent

echo "==> Installing the worker systemd unit (started later by cloud-init on each burst VM)..."
mkdir -p /etc/cogniumlearn
cat >/etc/systemd/system/cogniumlearn-worker.service <<'EOF'
[Unit]
Description=CogniumLearn Agent worker
After=docker.service network-online.target
Requires=docker.service

[Service]
Restart=always
EnvironmentFile=/etc/cogniumlearn/worker.env
ExecStartPre=-/usr/bin/docker rm -f cogniumlearn-worker
ExecStart=/usr/bin/docker run --rm --name cogniumlearn-worker --env-file /etc/cogniumlearn/worker.env cogniumlearn-agent
ExecStop=/usr/bin/docker stop cogniumlearn-worker

[Install]
WantedBy=multi-user.target
EOF
systemctl enable cogniumlearn-worker.service

echo "==> Clearing the containerd image-store cache (the #1 capture gotcha)..."
# Modern Docker stores images via the containerd snapshotter in /var/lib/containerd,
# and `docker image prune` does NOT remove orphaned snapshots there — they pile up to
# many GB and quietly blow the cap. Save → wipe the store → reload the one image.
docker save -o /root/cogniumlearn-agent.tar cogniumlearn-agent:latest
systemctl stop docker docker.socket containerd
rm -rf /var/lib/containerd/*
systemctl start containerd docker
docker load -i /root/cogniumlearn-agent.tar
rm -f /root/cogniumlearn-agent.tar

echo "==> Trimming the OS (docs, man pages, locales, apt lists, logs)..."
apt-get clean
rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/locale/*
journalctl --vacuum-size=10M 2>/dev/null || true
rm -rf /var/log/*.gz /var/log/*.[0-9] /tmp/* /root/.cache
docker container prune -f

echo "==> Final disk usage:"
df -h /
USED_KILOBYTES="$(df --output=used / | tail -n 1 | tr -d ' ')"
if [ "$USED_KILOBYTES" -gt "$MAXIMUM_USED_KILOBYTES" ]
then
    echo "ERROR: $((USED_KILOBYTES / 1024)) MB used exceeds the 5.4 GB capture limit. Aborting before capture."
    exit 1
fi

echo "==> Bakebox provisioning complete; ready for capture."
