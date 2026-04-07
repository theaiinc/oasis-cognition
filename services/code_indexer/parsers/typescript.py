"""TypeScript/JavaScript parser using Tree-sitter for accurate AST parsing."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tree_sitter import Language, Parser

from services.code_indexer.parsers.base import BaseParser
from services.code_indexer.models import Symbol, ImportInfo, File, SymbolType, Visibility

_ts_language_cache: dict[str, Language] = {}


def _language_for_path(file_path: Path) -> Language:
    """Load Tree-sitter grammar: TSX for .tsx/.jsx, TypeScript for .ts/.js."""
    suf = file_path.suffix.lower()
    key = "tsx" if suf in (".tsx", ".jsx") else "ts"
    if key in _ts_language_cache:
        return _ts_language_cache[key]
    import tree_sitter_typescript as tsp

    if key == "tsx":
        ptr = tsp.language_tsx()
    else:
        ptr = tsp.language_typescript()
    lang = Language(ptr)
    _ts_language_cache[key] = lang
    return lang


def _parse_source_tree(file_path: Path, content: str) -> Any:
    """Return root AST node or raise."""
    lang = _language_for_path(file_path)
    try:
        parser = Parser(lang)
    except TypeError:
        parser = Parser()
        parser.language = lang
    tree = parser.parse(bytes(content, "utf8"))
    return tree.root_node


class TypeScriptParser(BaseParser):
    """Parser for TypeScript and JavaScript files using Tree-sitter."""

    @property
    def supported_extensions(self) -> set[str]:
        return {".ts", ".tsx", ".js", ".jsx"}

    @property
    def language_name(self) -> str:
        return "typescript"

    def parse_file(self, file_path: Path, content: str | None = None) -> dict[str, Any]:
        if content is None:
            try:
                content = file_path.read_text(encoding="utf-8")
            except Exception as e:
                return {"error": str(e), "symbols": [], "imports": []}

        try:
            root = _parse_source_tree(file_path, content)
        except Exception as e:
            return {"error": str(e), "symbols": [], "imports": []}

        suf = file_path.suffix.lower()
        lang_label = "tsx" if suf == ".tsx" else "ts"

        file_info = File(
            path=str(file_path.resolve()) if file_path.is_absolute() else str(file_path),
            name=file_path.name,
            language=lang_label,
            content_hash=self._compute_hash(content),
            last_indexed=__import__("datetime").datetime.now(),
            line_count=content.count("\n") + 1,
            is_test=self._is_test_file(file_path),
            is_entry_point=self._is_entry_point(file_path),
        )

        symbols = self._extract_symbols_from_ast(root, file_path, content)
        imports = self._extract_imports_from_ast(root, content)
        relationships = self._extract_relationships_from_ast(root, file_path, content, symbols)

        return {
            "file_info": file_info,
            "symbols": symbols,
            "imports": imports,
            "relationships": relationships,
        }

    def _extract_symbols_from_ast(
        self,
        root_node: Any,
        file_path: Path,
        content: str,
    ) -> list[Symbol]:
        symbols: list[Symbol] = []

        def traverse(node: Any) -> None:
            node_type = node.type

            if node_type == "function_declaration":
                name = node.child_by_field_name("name")
                if name:
                    sym = self._create_symbol_from_node(
                        node, name.text.decode("utf8"), SymbolType.FUNCTION, file_path, content
                    )
                    if sym:
                        symbols.append(sym)

            elif node_type == "method_definition":
                name = node.child_by_field_name("name")
                if name and name.type == "property_identifier":
                    sym = self._create_symbol_from_node(
                        node, name.text.decode("utf8"), SymbolType.METHOD, file_path, content
                    )
                    if sym:
                        symbols.append(sym)

            elif node_type == "class_declaration":
                name = node.child_by_field_name("name")
                if name:
                    sym = self._create_symbol_from_node(
                        node, name.text.decode("utf8"), SymbolType.CLASS, file_path, content
                    )
                    if sym:
                        symbols.append(sym)

            elif node_type == "interface_declaration":
                name = node.child_by_field_name("name")
                if name:
                    sym = self._create_symbol_from_node(
                        node, name.text.decode("utf8"), SymbolType.INTERFACE, file_path, content
                    )
                    if sym:
                        symbols.append(sym)

            elif node_type == "type_alias_declaration":
                name = node.child_by_field_name("name")
                if name:
                    sym = self._create_symbol_from_node(
                        node, name.text.decode("utf8"), SymbolType.TYPE, file_path, content
                    )
                    if sym:
                        symbols.append(sym)

            elif node_type == "enum_declaration":
                name = node.child_by_field_name("name")
                if name:
                    sym = self._create_symbol_from_node(
                        node, name.text.decode("utf8"), SymbolType.ENUM, file_path, content
                    )
                    if sym:
                        symbols.append(sym)

            elif node_type == "lexical_declaration":
                for child in node.named_children:
                    if child.type == "variable_declarator":
                        n = child.child_by_field_name("name")
                        val = child.child_by_field_name("value")
                        if n and val and val.type in ("arrow_function", "function"):
                            sym = self._create_symbol_from_node(
                                node, n.text.decode("utf8"), SymbolType.FUNCTION, file_path, content
                            )
                            if sym:
                                symbols.append(sym)

            for child in node.children:
                traverse(child)

        traverse(root_node)
        return symbols

    def _create_symbol_from_node(
        self,
        node: Any,
        name: str,
        symbol_type: SymbolType,
        file_path: Path,
        content: str,
    ) -> Symbol | None:
        try:
            start_line = node.start_point[0] + 1
            end_line = node.end_point[0] + 1
            docstring = self._extract_docstring_before_node(node, content)
            lines = content.split("\n")
            signature_lines: list[str] = []
            for i in range(max(0, start_line - 1), min(len(lines), end_line)):
                line = lines[i].strip()
                if line:
                    signature_lines.append(line)
                    if len(signature_lines) >= 5:
                        break
            signature = " ".join(signature_lines)[:300]

            src = content.encode("utf8")
            node_src = node.text if hasattr(node, "text") else src[node.start_byte : node.end_byte]
            if isinstance(node_src, bytes):
                decl = node_src.decode("utf8", errors="replace")
            else:
                decl = str(node_src)
            is_exported = "export" in decl[:200]
            is_default = "export default" in decl[:200]

            return Symbol(
                id=f"{file_path}:{name}:{start_line}",
                name=name,
                type=symbol_type,
                file_path=str(file_path),
                signature=signature,
                docstring=docstring,
                line_start=start_line,
                line_end=end_line,
                is_exported=is_exported,
                is_default_export=is_default,
                visibility=Visibility.PUBLIC if is_exported else Visibility.PRIVATE,
            )
        except Exception:
            return None

    def _extract_docstring_before_node(self, node: Any, content: str) -> str:
        lines = content.split("\n")
        start_line = node.start_point[0]
        doc_lines: list[str] = []
        for i in range(max(0, start_line - 2), start_line):
            line = lines[i].strip()
            if line.startswith("/**"):
                doc_lines.insert(0, line)
                for j in range(i + 1, min(len(lines), i + 10)):
                    if lines[j].strip().startswith("*"):
                        doc_lines.insert(0, lines[j].strip())
                    elif lines[j].strip().startswith("*/"):
                        doc_lines.insert(0, lines[j].strip())
                        break
                break
            elif line.startswith("*") or line.startswith("/**"):
                doc_lines.insert(0, line)
            elif line and not line.startswith("//"):
                break
        return " ".join(doc_lines)[:500] if doc_lines else ""

    def _extract_imports_from_ast(self, root_node: Any, content: str) -> list[ImportInfo]:
        imports: list[ImportInfo] = []

        def traverse(node: Any) -> None:
            if node.type == "import_statement":
                self._process_import_statement(node, content, imports)
            for child in node.children:
                traverse(child)

        traverse(root_node)
        return imports

    def _process_import_statement(self, node: Any, content: str, imports: list[ImportInfo]) -> None:
        source_path = None
        for child in node.named_children:
            if child.type == "string":
                raw = child.text.decode("utf8") if isinstance(child.text, bytes) else str(child.text)
                source_path = raw.strip("\"'")
                break
        if not source_path:
            return

        line_num = node.start_point[0] + 1
        imported_names: list[str] = []
        is_default = False
        is_namespace = False

        for child in node.named_children:
            if child.type == "import_clause":
                for sub in child.named_children:
                    if sub.type == "identifier":
                        is_default = True
                        imported_names.append(sub.text.decode("utf8"))
                    elif sub.type == "named_imports":
                        for imp in sub.named_children:
                            if imp.type == "import_specifier":
                                nm = imp.child_by_field_name("name")
                                if nm:
                                    imported_names.append(nm.text.decode("utf8"))
                    elif sub.type == "namespace_import":
                        is_namespace = True
                        star = sub.child_by_field_name("name")
                        if star:
                            imported_names.append(star.text.decode("utf8"))

        imports.append(
            ImportInfo(
                source=source_path,
                imported_names=imported_names,
                is_default=is_default,
                is_namespace=is_namespace,
                line=line_num,
            )
        )

    def _extract_relationships_from_ast(
        self,
        root_node: Any,
        file_path: Path,
        content: str,
        symbols: list[Symbol],
    ) -> list[dict[str, Any]]:
        relationships: list[dict[str, Any]] = []
        names = {s.name for s in symbols}

        def traverse(node: Any) -> None:
            if node.type == "call_expression":
                func = node.child_by_field_name("function")
                if func and func.type == "identifier":
                    func_name = func.text.decode("utf8")
                    if func_name in names:
                        relationships.append(
                            {
                                "from": str(file_path),
                                "to": func_name,
                                "type": "CALLS",
                                "line": node.start_point[0] + 1,
                            }
                        )
            for child in node.children:
                traverse(child)

        traverse(root_node)
        return relationships
