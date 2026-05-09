# sphinx_doctor/paths.py

from __future__ import annotations

from pathlib import Path, PurePosixPath


def module_name_from_repo_path(repo_relative_path: str) -> str:
    """Return the import-style module name for a repo-relative Python file."""
    pure_path = PurePosixPath(repo_relative_path.lstrip("./"))
    parts = list(pure_path.parts)

    if parts and parts[0] == "src":
        parts = parts[1:]

    if not parts:
        return ""

    if parts[-1] == "__init__.py":
        parts = parts[:-1]
    elif parts[-1].endswith(".py"):
        parts[-1] = parts[-1][:-3]

    return ".".join(parts)


def relative_posix_path(path: Path, base: Path) -> str:
    """Return a stable POSIX relative path from base to path."""
    return path.resolve().relative_to(base.resolve()).as_posix()


def ensure_parent(path: Path) -> None:
    """Create the parent directory for the output path when needed."""
    path.parent.mkdir(parents=True, exist_ok=True)