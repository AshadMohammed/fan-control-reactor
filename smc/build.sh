#!/bin/bash
# Build the smcfan helper. No root needed to build or to read.
set -euo pipefail

cd "$(dirname "$0")"

CC="${CC:-clang}"
CFLAGS="${CFLAGS:--O2 -Wall -Wextra -Wpedantic -std=c11}"

# shellcheck disable=SC2086
"$CC" $CFLAGS -o smcfan smcfan.c -framework IOKit

echo "built $(pwd)/smcfan"
