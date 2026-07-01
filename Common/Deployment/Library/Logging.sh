#!/usr/bin/env bash
#
# Console logging helpers for the deployment orchestrator. Sourced by deploy.sh.
# Colours degrade gracefully when stdout is not a terminal (e.g. piped to a file).

if [ -t 1 ]
then
    LOG_COLOUR_RESET="$(printf '\033[0m')"
    LOG_COLOUR_BLUE="$(printf '\033[1;34m')"
    LOG_COLOUR_GREEN="$(printf '\033[1;32m')"
    LOG_COLOUR_YELLOW="$(printf '\033[1;33m')"
    LOG_COLOUR_RED="$(printf '\033[1;31m')"
else
    LOG_COLOUR_RESET=""
    LOG_COLOUR_BLUE=""
    LOG_COLOUR_GREEN=""
    LOG_COLOUR_YELLOW=""
    LOG_COLOUR_RED=""
fi

log_step()
{
    printf '%s==> %s%s\n' "$LOG_COLOUR_BLUE" "$*" "$LOG_COLOUR_RESET"
}

log_info()
{
    printf '    %s\n' "$*"
}

log_success()
{
    printf '%s✓ %s%s\n' "$LOG_COLOUR_GREEN" "$*" "$LOG_COLOUR_RESET"
}

log_warning()
{
    printf '%s⚠ %s%s\n' "$LOG_COLOUR_YELLOW" "$*" "$LOG_COLOUR_RESET" >&2
}

log_error()
{
    printf '%s✗ %s%s\n' "$LOG_COLOUR_RED" "$*" "$LOG_COLOUR_RESET" >&2
}
