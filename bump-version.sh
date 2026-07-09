#!/usr/bin/env bash
#
# bump-version.sh — Bump version across all platforms (Chrome, Firefox, Safari, Android)
#
# Usage:
#   ./bump-version.sh 0.1.0
#

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <new-version>"
  exit 1
fi

NEW_VERSION="$1"

# Basic SemVer check
if [[ ! "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: Version '$NEW_VERSION' is not a valid semantic version (e.g., 0.1.0)"
  exit 1
fi

echo "Bumping version to $NEW_VERSION..."

# Python helper to update JSON files in-place
update_json() {
  local file="$1"
  local key="$2"
  local val="$3"
  python3 -c "
import json
with open('$file', 'r') as f:
    data = json.load(f)
data['$key'] = '$val'
with open('$file', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"
}

# Update JSON manifests
update_json "Intention Chrome/manifest.json" "version" "$NEW_VERSION"
update_json "Intention Firefox/manifest.json" "version" "$NEW_VERSION"
update_json "Intention Apple/Shared (Extension)/Resources/manifest.json" "version" "$NEW_VERSION"
update_json "package.json" "version" "$NEW_VERSION"

# Update Android Gradle file
python3 -c "
import sys, re
new_ver = sys.argv[1]
file_path = 'Intention Android/app/build.gradle.kts'
with open(file_path, 'r') as f:
    content = f.read()

# Update versionName
content = re.sub(r'versionName\s*=\s*\".*\"', f'versionName = \"{new_ver}\"', content)

# Increment versionCode
version_code_match = re.search(r'versionCode\s*=\s*(\d+)', content)
if version_code_match:
    old_code = int(version_code_match.group(1))
    new_code = old_code + 1
    content = re.sub(r'versionCode\s*=\s*\d+', f'versionCode = {new_code}', content)

with open(file_path, 'w') as f:
    f.write(content)
" "$NEW_VERSION"

echo "✓ Version bumped in all files"

# Run build to compile assets, check parity, run test suite, and generate new zips
./build.sh --all
