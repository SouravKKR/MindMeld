# MindMeld Agent worker image (multi-stage).
#
# Runs Agent/Worker.py — the long-lived poller that drains the shared Redis task
# queue. The same image runs on the base node and on every burst VM (baked into
# the Linode custom Image documented in Common/ReadmeFiles/Deployment.md).
# It connects to Redis and MongoDB over the VPC private network using env injected
# at runtime.
#
# Debian/glibc base (NOT Alpine/musl) is deliberate: the worker pulls torch,
# torchvision, opencv, scipy, scikit-learn, PyMuPDF, etc., which ship prebuilt
# glibc (manylinux) wheels. On musl those have no wheels and would compile from
# source (slow, fragile) — exactly the startup pain we want to avoid.
#
# Build context is the Agent/ directory:
#   docker build -t mindmeld-agent -f Dockerfile .

# ── Stage 1: builder — installs everything into an isolated venv ─────────────
FROM python:3.12-slim AS builder

# Toolchain only needed to build the few packages without a matching wheel
# (e.g. cffi). It stays in this stage and never reaches the runtime image.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        build-essential \
        libffi-dev \
    && rm -rf /var/lib/apt/lists/*

ENV PIP_NO_CACHE_DIR=1

# Self-contained venv we can copy wholesale into the runtime stage.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Dependencies first for layer caching. requirements.txt is plain UTF-8.
COPY requirements.txt /tmp/requirements.txt
RUN pip install --upgrade pip \
    && pip install -r /tmp/requirements.txt

# ── Stage 2: runtime — slim image carrying only the venv + shared libs ───────
FROM python:3.12-slim

# Shared libraries the installed wheels load at runtime:
#   - libgomp1            : OpenMP, used by numpy / scipy / scikit-learn / torch
#   - libgl1, libglib2.0-0: OpenCV (opencv-python) image ops
# (PyMuPDF / Pillow bundle their own native bits in the wheel.)
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        libgomp1 \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/Agent

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app/Agent

# Copy the Agent source. The .dockerignore keeps the local venv, caches and
# secrets out of the image.
COPY . /app/Agent

# The worker is the entrypoint. Pass --debug via the command for verbose logs.
ENTRYPOINT ["python", "Worker.py"]
