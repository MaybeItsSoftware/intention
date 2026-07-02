#!/usr/bin/env bash
#
# bump-version.sh — bump the extension version across every platform in one shot.
#
# Usage:
#   scripts/bump-version.sh <version> [build_number]
#
# Updates:
#   - Intention Chrome/manifest.json               "version"
#   - Intention Firefox/manifest.json               "version"
#   - Intention Apple/.../project.pbxproj           MARKETING_VERSION (all build configs)
#                                                    CURRENT_PROJECT_VERSION (all configs, if build_number given)
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

CHROME_MANIFEST="Intention Chrome/manifest.json"
FIREFOX_MANIFEST="Intention Firefox/manifest.json"
PBXPROJ="Intention Apple/Intention Safari.xcodeproj/project.pbxproj"

echo "Bumping version to $VERSION${BUILD:+ (build $BUILD)}"

sed -i.bak -E "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$CHROME_MANIFEST"
sed -i.bak -E "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$FIREFOX_MANIFEST"
rm -f "$CHROME_MANIFEST.bak" "$FIREFOX_MANIFEST.bak"
echo "  ✓ $CHROME_MANIFEST"
echo "  ✓ $FIREFOX_MANIFEST"

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

echo ""
echo "Done. Next steps:"
echo "  ./build.sh --all   # verify builds + cross-platform sync"
echo "  git add -A && git commit -m \"Bump version to $VERSION\""
echo "  git tag v$VERSION && git push origin v$VERSION"
