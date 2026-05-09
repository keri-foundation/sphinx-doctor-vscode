# sphinx_doctor/source_mapping.py

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from sphinx_doctor.paths import module_name_from_repo_path


@dataclass(frozen=True)
class SourceRange:
    """Concrete source anchor for a mapped issue."""

    start_line: int
    start_column: int
    end_line: int
    end_column: int
    anchor_kind: str

    def to_dict(self) -> dict[str, int | str]:
        return {
            "startLine": self.start_line,
            "startColumn": self.start_column,
            "endLine": self.end_line,
            "endColumn": self.end_column,
            "anchorKind": self.anchor_kind,
        }


@dataclass(frozen=True)
class HostInfo:
    """Indexed docstring-bearing Python host."""

    qualname: str
    kind: str
    start_line: int
    end_line: int
    start_column: int
    end_column: int
    docstring_start_line: int | None
    docstring_end_line: int | None
    docstring_start_column: int | None
    docstring_end_column: int | None


@dataclass(frozen=True)
class MappingResult:
    """Resolved mapping output for one issue."""

    source_range: SourceRange | None
    confidence: str
    strategy: str
    reason: str
    object_resolved: bool
    line_resolved: bool
    resolved_kind: str | None


def _first_statement_docstring(body: list[ast.stmt]) -> ast.Expr | None:
    if not body:
        return None

    first = body[0]
    if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
        if isinstance(first.value.value, str):
            return first
    return None


def _make_host(
    qualname: str,
    kind: str,
    start_line: int,
    end_line: int,
    start_column: int,
    end_column: int,
    docstring_node: ast.Expr | None,
) -> HostInfo:
    if docstring_node is None:
        return HostInfo(
            qualname=qualname,
            kind=kind,
            start_line=start_line,
            end_line=end_line,
            start_column=start_column,
            end_column=end_column,
            docstring_start_line=None,
            docstring_end_line=None,
            docstring_start_column=None,
            docstring_end_column=None,
        )

    return HostInfo(
        qualname=qualname,
        kind=kind,
        start_line=start_line,
        end_line=end_line,
        start_column=start_column,
        end_column=end_column,
        docstring_start_line=docstring_node.lineno,
        docstring_end_line=docstring_node.end_lineno,
        docstring_start_column=docstring_node.col_offset + 1,
        docstring_end_column=docstring_node.end_col_offset + 1,
    )


def build_host_index(source_path: Path, repo_relative_path: str) -> dict[str, HostInfo]:
    """Build a lexical index of module, class, and function hosts."""
    source_text = source_path.read_text()
    tree = ast.parse(source_text)
    lines = source_text.splitlines()
    end_column = len(lines[-1]) + 1 if lines else 1
    module_name = module_name_from_repo_path(repo_relative_path)

    index: dict[str, HostInfo] = {}
    module_docstring = _first_statement_docstring(tree.body)
    index[module_name] = _make_host(
        qualname=module_name,
        kind="module",
        start_line=1,
        end_line=max(len(lines), 1),
        start_column=1,
        end_column=end_column,
        docstring_node=module_docstring,
    )

    def visit(nodes: Iterable[ast.stmt], parent_name: str) -> None:
        for node in nodes:
            if isinstance(node, ast.ClassDef):
                qualname = f"{parent_name}.{node.name}"
                docstring_node = _first_statement_docstring(node.body)
                index[qualname] = _make_host(
                    qualname=qualname,
                    kind="class",
                    start_line=node.lineno,
                    end_line=node.end_lineno,
                    start_column=node.col_offset + 1,
                    end_column=node.end_col_offset + 1,
                    docstring_node=docstring_node,
                )
                visit(node.body, qualname)
            elif isinstance(node, ast.AsyncFunctionDef):
                qualname = f"{parent_name}.{node.name}"
                docstring_node = _first_statement_docstring(node.body)
                index[qualname] = _make_host(
                    qualname=qualname,
                    kind="async-function",
                    start_line=node.lineno,
                    end_line=node.end_lineno,
                    start_column=node.col_offset + 1,
                    end_column=node.end_col_offset + 1,
                    docstring_node=docstring_node,
                )
                visit(node.body, qualname)
            elif isinstance(node, ast.FunctionDef):
                qualname = f"{parent_name}.{node.name}"
                docstring_node = _first_statement_docstring(node.body)
                index[qualname] = _make_host(
                    qualname=qualname,
                    kind="function",
                    start_line=node.lineno,
                    end_line=node.end_lineno,
                    start_column=node.col_offset + 1,
                    end_column=node.end_col_offset + 1,
                    docstring_node=docstring_node,
                )
                visit(node.body, qualname)

    visit(tree.body, module_name)
    return index


def resolve_host(
    source_path: Path,
    repo_relative_path: str,
    object_name: str,
) -> HostInfo | None:
    """Resolve one fully qualified object name inside a Python source file."""
    return build_host_index(source_path, repo_relative_path).get(object_name)


def _line_columns(source_lines: list[str], line_number: int) -> tuple[int, int]:
    if line_number < 1 or line_number > len(source_lines):
        return (1, 1)

    source_line = source_lines[line_number - 1]
    first_non_space = len(source_line) - len(source_line.lstrip(" "))
    return (first_non_space + 1, len(source_line) + 1)


def map_issue_to_source(
    source_root: Path,
    repo_relative_path: str | None,
    object_name: str | None,
    docstring_line: int | None,
) -> MappingResult:
    """Map one raw issue to a best-effort source anchor."""
    if not repo_relative_path:
        return MappingResult(
            source_range=None,
            confidence="none",
            strategy="inventory-retention-only",
            reason="No repo-relative source path was provided.",
            object_resolved=False,
            line_resolved=False,
            resolved_kind=None,
        )

    source_path = source_root / repo_relative_path
    if not source_path.exists():
        return MappingResult(
            source_range=None,
            confidence="none",
            strategy="source-file-missing",
            reason="The repo-relative path did not resolve under the provided source root.",
            object_resolved=False,
            line_resolved=False,
            resolved_kind=None,
        )

    try:
        source_text = source_path.read_text()
        source_lines = source_text.splitlines()
        host_index = build_host_index(source_path, repo_relative_path)
    except SyntaxError:
        return MappingResult(
            source_range=None,
            confidence="none",
            strategy="source-parse-error",
            reason="The source file could not be parsed with ast.parse().",
            object_resolved=False,
            line_resolved=False,
            resolved_kind=None,
        )

    if object_name is None:
        return MappingResult(
            source_range=None,
            confidence="none",
            strategy="inventory-retention-only",
            reason="No object name was provided for source mapping.",
            object_resolved=False,
            line_resolved=False,
            resolved_kind=None,
        )

    host = host_index.get(object_name)
    if host is None:
        return MappingResult(
            source_range=None,
            confidence="none",
            strategy="inventory-retention-only",
            reason="The object name could not be resolved to a lexical host in the source file.",
            object_resolved=False,
            line_resolved=False,
            resolved_kind=None,
        )

    if (
        host.docstring_start_line is not None
        and host.docstring_end_line is not None
        and docstring_line is not None
        and docstring_line >= 1
    ):
        physical_line = host.docstring_start_line + docstring_line
        docstring_content_end = host.docstring_end_line - 1
        if physical_line <= docstring_content_end:
            start_column, end_column = _line_columns(source_lines, physical_line)
            return MappingResult(
                source_range=SourceRange(
                    start_line=physical_line,
                    start_column=start_column,
                    end_line=physical_line,
                    end_column=end_column,
                    anchor_kind="docstring-line",
                ),
                confidence="high",
                strategy="ast-docstring-cleaned-line",
                reason="Fully qualified object resolved and docstring-relative line mapped inside the docstring literal span.",
                object_resolved=True,
                line_resolved=True,
                resolved_kind=host.kind,
            )

    if host.docstring_start_line is not None and host.docstring_end_line is not None:
        return MappingResult(
            source_range=SourceRange(
                start_line=host.docstring_start_line,
                start_column=host.docstring_start_column or 1,
                end_line=host.docstring_end_line,
                end_column=host.docstring_end_column or 1,
                anchor_kind="docstring-block",
            ),
            confidence="low",
            strategy="ast-docstring-block-fallback",
            reason="Object resolved, but the requested docstring-relative line could not be mapped exactly; anchored to the docstring block.",
            object_resolved=True,
            line_resolved=False,
            resolved_kind=host.kind,
        )

    return MappingResult(
        source_range=SourceRange(
            start_line=host.start_line,
            start_column=host.start_column,
            end_line=host.end_line,
            end_column=host.end_column,
            anchor_kind="object-block",
        ),
        confidence="low",
        strategy="ast-object-block-fallback",
        reason="Object resolved, but no docstring host was available; anchored to the object block.",
        object_resolved=True,
        line_resolved=False,
        resolved_kind=host.kind,
    )