#!/usr/bin/env bash
# Download the raw inputs used by tools/build_data.py (~200 MB, not redistributed in this repo).
set -euo pipefail
mkdir -p sources && cd sources
[ -d Drosophila_brain_model ] || git clone --depth 1 https://github.com/philshiu/Drosophila_brain_model
[ -d flywire_annotations ] || git clone --depth 1 https://github.com/flyconnectome/flywire_annotations
echo "sources ready — now run: python3 tools/build_data.py"
