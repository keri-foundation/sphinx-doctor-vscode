#!/usr/bin/env bash
set -euo pipefail

CODE_CLI="${CODE_CLI:-code}"
SKIP_TESTS="${SKIP_TESTS:-0}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
cd "${repo_root}"

echo "== Sphinx Doctor local VSIX reinstall =="
echo "Repo: ${repo_root}"
echo "Code CLI: ${CODE_CLI}"

command -v "${CODE_CLI}" >/dev/null 2>&1 || {
  echo "ERROR: VS Code CLI not found: ${CODE_CLI}" >&2
  echo "Set CODE_CLI=/path/to/code or install the 'code' shell command." >&2
  exit 1
}

echo ""
echo "--- Compile ---"
npm run compile

if [[ "${SKIP_TESTS}" != "1" ]]; then
  echo ""
  echo "--- Tests ---"
  npm test
else
  echo ""
  echo "WARNING: SKIP_TESTS=1 set; skipping npm test."
fi

echo ""
echo "--- Package ---"
npm run package

vsix="$(ls -t sphinx-doctor-vscode-*.vsix 2>/dev/null | head -1 || true)"
if [[ -z "${vsix}" ]]; then
  echo "ERROR: No sphinx-doctor-vscode-*.vsix found after package." >&2
  exit 1
fi

echo ""
echo "--- Install ---"
echo "Installing ${vsix}"
"${CODE_CLI}" --install-extension "${vsix}" --force

echo ""
echo "--- Best-effort installed marker verification ---"

# Locate the installed extension directory
installed_dir="$(
  ls -dt "${HOME}/.vscode/extensions/keri-foundation.sphinx-doctor-vscode-"* 2>/dev/null | head -1 || true
)"

if [[ -z "${installed_dir}" ]]; then
  echo "WARNING: Could not locate installed extension directory under ~/.vscode/extensions/."
  echo "The VSIX was installed; use Sphinx Doctor: Troubleshoot Environment as the source of truth."
else
  echo "Installed extension directory: ${installed_dir}"

  verify_marker() {
    local file="$1"
    local marker="$2"
    local label="$3"
    local full_path="${installed_dir}/${file}"
    if [[ -f "${full_path}" ]]; then
      if grep -q -F "${marker}" "${full_path}" 2>/dev/null; then
        echo "  OK: ${label} found in ${file}"
      else
        echo "  WARNING: ${label} NOT found in ${file}"
      fi
    else
      echo "  WARNING: ${file} not found in installed extension"
    fi
  }

  verify_marker "out/src/runner/SphinxDoctorRunner.js" "'-E'" "-E flag"
  verify_marker "out/src/parser/SphinxWarningParser.js" "astDegraded" "astDegraded fallback"
  verify_marker "out/src/commands.js" "Direct-run diagnostics published" "direct-run publish log"
  verify_marker "out/src/commands.js" "noteManualDiagnosticsPublished" "status bar wiring"
fi

echo ""
echo "== NEXT STEPS =="
echo "1. Reload the target VS Code window: Developer: Reload Window"
echo "2. Run: Sphinx Doctor: Troubleshoot Environment"
echo "3. Confirm Production mode and installed extension path"
echo "4. Run: Sphinx Doctor: Clear Diagnostics"
echo "5. Run: Sphinx Doctor: Run Sphinx Build"
echo "6. Confirm args include -E and Problems/status bar populate"
