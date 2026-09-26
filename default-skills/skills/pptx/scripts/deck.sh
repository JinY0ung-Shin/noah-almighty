#!/usr/bin/env bash
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
exec node "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../converter/tools/deck.mjs" "$@"
