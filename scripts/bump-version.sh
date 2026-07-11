#!/usr/bin/env bash
#
# bump-version.sh — bump the extension version across every platform in one shot.
#
# Usage:
#   scripts/bump-version.sh <version> [build_number]
#
# Updates:
#   - shared/manifest.base.json                     "version" (single source of truth;
#                                                    platform manifests regenerated via sync.sh)
#   - Intention Apple/.../project.pbxproj           MARKETING_VERSION (all build configs)
#                                                    CURRENT_PROJECT_VERSION (all configs, if build_number given)
#   - Intention Android/app/build.gradle.kts        versionName (+ versionCode incremented)
#   - package.json                                  "version"
#
# Does not commit or tag. After running:
#   ./build.sh --all
#   git add -A && git commit -m "Bump version to X.Y"
#   git tag vX.Y && git push origin vX.Y

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

VERSION="${1:-}"
BUILD="${2:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version> [build_number]" >&2
  echo "  e.g. $0 2.1" >&2
  echo "       $0 2.1 3   (also sets Xcode CURRENT_PROJECT_VERSION)" >&2
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+(\.[0-9]+){1,3}$ ]]; then
  echo "Version must look like 2.1 or 2.1.3" >&2
  exit 1
fi

BASE_MANIFEST="shared/manifest.base.json"
PBXPROJ="Intention Apple/Intention Safari.xcodeproj/project.pbxproj"
ANDROID_GRADLE="Intention Android/app/build.gradle.kts"

echo "Bumping version to $VERSION${BUILD:+ (build $BUILD)}"

sed -i.bak -E "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$BASE_MANIFEST"
rm -f "$BASE_MANIFEST.bak"
echo "  ✓ $BASE_MANIFEST"

scripts/sync.sh > /dev/null
echo "  ✓ platform manifests regenerated (scripts/sync.sh)"

sed -i.bak -E "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" package.json
rm -f package.json.bak
echo "  ✓ package.json"

if [[ -f "$PBXPROJ" ]]; then
  sed -i.bak -E "s/MARKETING_VERSION = [0-9.]+;/MARKETING_VERSION = $VERSION;/" "$PBXPROJ"
  if [[ -n "$BUILD" ]]; then
    sed -i.bak -E "s/CURRENT_PROJECT_VERSION = [0-9]+;/CURRENT_PROJECT_VERSION = $BUILD;/" "$PBXPROJ"
  fi
  rm -f "$PBXPROJ.bak"
  echo "  ✓ $PBXPROJ"
else
  echo "  ! $PBXPROJ not found — skipping Safari version bump"
fi

if [[ -f "$ANDROID_GRADLE" ]]; then
  python3 -c "
import re
path = '$ANDROID_GRADLE'
with open(path) as f:
    content = f.read()
content = re.sub(r'versionName\s*=\s*\".*\"', 'versionName = \"$VERSION\"', content)
match = re.search(r'versionCode\s*=\s*(\d+)', content)
if match:
    content = re.sub(r'versionCode\s*=\s*\d+', f'versionCode = {int(match.group(1)) + 1}', content)
with open(path, 'w') as f:
    f.write(content)
"
  echo "  ✓ $ANDROID_GRADLE"
else
  echo "  ! $ANDROID_GRADLE not found — skipping Android version bump"
fi

echo ""
echo "Done. Next steps:"
echo "  ./build.sh --all   # verify builds + cross-platform sync"
echo "  git add -A && git commit -m \"Bump version to $VERSION\""
echo "  git tag v$VERSION && git push origin v$VERSION"
