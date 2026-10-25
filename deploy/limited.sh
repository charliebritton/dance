#!/bin/sh
# Run a heavy one-off command (test browsers, renders, builds) on the VPS without starving the live sites:
# its own cgroup capped at 40% of the CPU and 900 MB of memory, lowest CPU and IO priority.
#   deploy/limited.sh node script.mjs
exec systemd-run --scope --quiet --collect -p CPUQuota=40% -p CPUWeight=10 -p MemoryMax=900M -p MemorySwapMax=256M \
  -p TasksMax=256 nice -n 19 ionice -c 3 "$@"
