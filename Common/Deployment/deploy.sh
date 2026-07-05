#!/usr/bin/env bash
#
# Back-compat wrapper. The single-environment deploy.sh is now the multi-environment
# deploy-environment.sh; this shim keeps the old invocation working by targeting the
# production environment. New work should call deploy-environment.sh (or the
# manage-environment skill) directly.
#
#   bash Common/Deployment/deploy.sh [flags]   ==   bash Common/Deployment/deploy-environment.sh production [flags]
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIRECTORY/deploy-environment.sh" production "$@"
