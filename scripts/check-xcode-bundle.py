#!/usr/bin/env python3
"""Assert every Xcode target bundles the files its own HTML pages ask for.

Xcode target membership is a list kept by hand, entirely separate from the
manifest and from the <script src> tags that actually load these files. A file
can be present in the source tree, synced to every platform directory, listed
in the manifest, referenced correctly by the page, and still be absent from the
built product -- and nothing says a word. This has now happened twice:

  - 4dde53c: eight files were missing from BOTH Safari extension targets. The
    whole content-script injection was dead (WebKit runs none of a page's
    content scripts if one file is missing) and options.html was missing six of
    its twelve scripts.
  - This check's own reason for existing: the same eight were then missing from
    the iOS *app* target, which is what an App Store reviewer launches.
    showSetupView() lives in options-wizard.js, so the DOMContentLoaded handler
    threw ReferenceError before unhiding either <main>, and the app opened to a
    blank page. Apple rejected 0.22.1 under guideline 2.1(a) for exactly that.

build.sh already had a check here and it passed both times, because it grepped
the whole project file for each filename. Every one of those files WAS in the
project file -- as a member of a different target. Membership is per target, so
the check has to be too. That is the difference this script exists to make.

Exits non-zero with a per-target list of what is missing.
"""

import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PBXPROJ = os.path.join(
    REPO_ROOT, "Intention Apple", "Intention Safari.xcodeproj", "project.pbxproj"
)

# Where each target's copy of a bundled HTML page actually lives. The app and
# the extension ship *different* background.html files (the app's is a WKWebView
# host that shims window.chrome; the extension gets the real thing from the
# browser), so resolving a page by basename alone would check the wrong file.
# First root that has the file wins.
HTML_ROOTS = {
    "Intention Safari (iOS)": [
        os.path.join("Intention Apple", "Shared (App)", "Resources"),
        "Intention Chrome",
    ],
    "Intention Safari (macOS)": [
        os.path.join("Intention Apple", "Shared (App)", "Resources"),
        "Intention Chrome",
    ],
    "Intention Safari Extension (iOS)": [
        os.path.join("Intention Apple", "Shared (Extension)", "Resources"),
    ],
    "Intention Safari Extension (macOS)": [
        os.path.join("Intention Apple", "Shared (Extension)", "Resources"),
    ],
}

# Stylesheets, scripts and images the page pulls in. Anything with a scheme or a
# fragment is remote or in-page, not a bundled file.
REF_RE = re.compile(r'(?:href|src)="([^"#?:]+)"')


def parse_target_resources(text):
    """{target name: set of basenames in its Resources build phase}."""
    build_files = {}
    for m in re.finditer(
        r"([0-9A-F]{24})\s*/\* (.+?) in Resources \*/ = \{isa = PBXBuildFile;", text
    ):
        build_files[m.group(1)] = m.group(2)

    phases = {}
    for m in re.finditer(
        r"([0-9A-F]{24}) /\* Resources \*/ = \{\n\t\t\tisa = PBXResourcesBuildPhase;(.*?)\n\t\t\};",
        text,
        re.S,
    ):
        phases[m.group(1)] = re.findall(r"([0-9A-F]{24}) /\*", m.group(2))

    targets = {}
    for m in re.finditer(
        r"\n\t\t([0-9A-F]{24}) /\* (.+?) \*/ = \{\n\t\t\tisa = PBXNativeTarget;", text
    ):
        name = m.group(2)
        segment = text[m.start() : m.start() + 4000]
        phase_list = re.search(r"buildPhases = \((.*?)\);", segment, re.S)
        if not phase_list:
            continue
        members = set()
        for uuid in re.findall(r"([0-9A-F]{24})", phase_list.group(1)):
            if uuid in phases:
                members.update(build_files.get(f, f) for f in phases[uuid])
        targets[name] = members
    return targets


def resolve(target, filename):
    for root in HTML_ROOTS.get(target, []):
        candidate = os.path.join(REPO_ROOT, root, filename)
        if os.path.isfile(candidate):
            return candidate
    return None


def main():
    if not os.path.isfile(PBXPROJ):
        print(f"error: {PBXPROJ} not found", file=sys.stderr)
        return 1

    text = open(PBXPROJ, encoding="utf-8").read()
    targets = parse_target_resources(text)

    for expected in HTML_ROOTS:
        if expected not in targets:
            print(
                f"error: target {expected!r} is not in the Xcode project any more -- "
                "this check is looking at the wrong targets",
                file=sys.stderr,
            )
            return 1

    failures = []
    checked = 0
    for target, members in sorted(targets.items()):
        pages = sorted(f for f in members if f.endswith(".html"))
        for page in pages:
            path = resolve(target, page)
            if path is None:
                failures.append(
                    f"{target}: bundles {page} but it is not in any known source root "
                    f"({', '.join(HTML_ROOTS.get(target, ['(none configured)']))})"
                )
                continue
            checked += 1
            html = open(path, encoding="utf-8").read()
            for ref in sorted(set(REF_RE.findall(html))):
                if os.path.basename(ref) != ref:
                    continue  # a path into a bundled folder reference, e.g. fonts/
                if ref not in members:
                    failures.append(
                        f"{target}: {page} loads {ref}, which is not in that target's "
                        "Resources build phase -- it will be missing from the built product"
                    )

    if not checked:
        print(
            "error: found no bundled HTML pages to check -- the project file layout "
            "changed and this check is no longer looking at anything",
            file=sys.stderr,
        )
        return 1

    if failures:
        print(
            "Xcode target membership is missing files its own pages load:\n",
            file=sys.stderr,
        )
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        print(
            "\nAdd them to that target's Resources build phase in Xcode "
            "(select the file, File inspector, tick the target).",
            file=sys.stderr,
        )
        return 1

    print(f"OK: every Xcode target bundles what its {checked} HTML pages load")
    return 0


if __name__ == "__main__":
    sys.exit(main())
