#!/bin/sh
# Bump the asset version so browsers never mix an old app.js with a new index.html.
# Usage: ./release.sh 6
set -e
v="$1"; [ -n "$v" ] || { echo "usage: $0 <version>"; exit 1; }
sed -i '' -E "s/\?v=[0-9]+/?v=$v/g" index.html app.js sw.js
sed -i '' -E "s/const CACHE = 'fpe-v[0-9]+';/const CACHE = 'fpe-v$v';/" sw.js
grep -n "?v=\|const CACHE" index.html app.js sw.js
