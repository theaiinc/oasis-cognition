# Code Indexing Service Design

## Problem Statement

The current "Knowledge Graph" stores task execution steps (reasoning graphs), not actual code knowledge. Agents must re-explore the codebase every session using `grep` and `list_dir`, wasting iterations on already-discovered information.

## Goal

Build a persistent code knowledge graph that stores:
- Symbols (functions, classes, interfaces, types)
- Relationships (imports, extends, implements, calls)
- File structure and metadata
- Documentation and comments

Enable agents to query: "Where is CodeBlock defined?", "What uses shiki?", "Show component hierarchy"

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CODE INDEXING SERVICE                                │
│                     (New microservice: code-indexer)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │ File Watcher │───▶│   Parser     │───▶│   Indexer    │                   │
│  │  (watchdog)  │    │ (tree-sitter)│    │  (Neo4j)     │                   │
│  └──────────────┘    └──────────────┘    └──────────────┘                   │
│         │                   │                   │                           │
│         ▼                   ▼                   ▼                           │
│  ┌─────────────────────────────────────────────────────┐                   │
│  │              Incremental Index Queue                 │                   │
│  │         (Redis-backed for durability)                │                   │
│  └─────────────────────────────────────────────────────┘                   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────┐                   │
│  │              Query API (FastAPI)                     │                   │
│  │  - GET /symbols/search?q=CodeBlock                   │                   │
│  │  - GET /symbols/{id}/references                      │                   │
│  │  - GET /files/{path}/imports                         │                   │
│  │  - GET /graph/component-hierarchy                    │                   │
│  └─────────────────────────────────────────────────────┘                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              NEO4J GRAPH                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Nodes:                                                                      │
│    - File {path, language, last_indexed, content_hash}                       │
│    - Symbol {name, type, signature, docstring, line_start, line_end}         │
│    - Module {name, package_path}                                             │
│    - Comment {text, type, line}                                              │
│                                                                              │
│  Relationships:                                                              │
│    - (File)-[:CONTAINS]->(Symbol)                                            │
│    - (Symbol)-[:IMPORTS]->(Symbol|Module)                                    │
│    - (Symbol)-[:EXTENDS]->(Symbol)                                           │
│    - (Symbol)-[:IMPLEMENTS]->(Symbol)                                        │
│    - (Symbol)-[:CALLS]->(Symbol)                                             │
│    - (Symbol)-[:EXPORTS]->(Module)                                           │
│    - (Symbol)-[:REFERENCED_BY]->(Symbol)                                     │
│    - (File)-[:DEPENDS_ON]->(File)                                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Neo4j Schema

### Node Types

```cypher
// File node - represents a source file
(:File {
  path: "apps/oasis-ui-react/src/components/chat/CodeBlock.tsx",
  name: "CodeBlock.tsx",
  language: "typescript",
  content_hash: "sha256:abc123...",
  last_indexed: datetime(),
  line_count: 150,
  is_test: false,
  is_entry_point: false
})

// Symbol node - function, class, interface, type, variable
(:Symbol {
  id: "apps/oasis-ui-react/src/components/chat/CodeBlock.tsx:CodeBlock:15",
  name: "CodeBlock",
  type: "function",  // function | class | interface | type | variable | const | enum
  signature: "function CodeBlock(props: CodeBlockProps): JSX.Element",
  docstring: "Renders syntax-highlighted code blocks...",
  line_start: 15,
  line_end: 45,
  column_start: 0,
  column_end: 1,
  is_exported: true,
  is_default_export: false,
  visibility: "public"  // public | private | protected
})

// Module node - package, namespace
(:Module {
  name: "@oasis/ui-react",
  path: "apps/oasis-ui-react",
  type: "package"  // package | namespace | internal
})

// Comment node - extracted documentation
(:Comment {
  text: "Renders syntax-highlighted code blocks",
  type: "jsdoc",  // jsdoc | line | block
  line: 10
})
```

### Relationship Types

```cypher
// File contains symbols
(:File)-[:CONTAINS {order: 1}]->(:Symbol)

// Symbol imports another symbol/module
(:Symbol)-[:IMPORTS {
  import_path: "shiki",
  is_default: false,
  imported_names: ["codeToHtml", "getHighlighter"]
}]->(:Module)

// Class/interface inheritance
(:Symbol)-[:EXTENDS]->(:Symbol)
(:Symbol)-[:IMPLEMENTS]->(:Symbol)

// Function/method calls
(:Symbol)-[:CALLS {line: 25, column: 10}]->(:Symbol)

// Symbol is exported from module
(:Symbol)-[:EXPORTS]->(:Module)

// Symbol is referenced by another symbol
(:Symbol)-[:REFERENCED_BY {line: 30, column: 5}]->(:Symbol)

// File depends on another file (via imports)
(:File)-[:DEPENDS_ON]->(:File)

// Symbol has documentation
(:Symbol)-[:DOCUMENTED_BY]->(:Comment)
```

---

## API Design

### Endpoints

```yaml
# Health check
GET /health
Response: {"status": "ok", "indexed_files": 1500, "indexed_symbols": 8500}

# Search symbols by name or pattern
GET /symbols/search?q=CodeBlock&limit=10
Response:
  symbols:
    - id: "apps/.../CodeBlock.tsx:CodeBlock:15"
      name: "CodeBlock"
      type: "function"
      file_path: "apps/oasis-ui-react/src/components/chat/CodeBlock.tsx"
      line: 15
      signature: "function CodeBlock(props: CodeBlockProps): JSX.Element"

# Get symbol details with relationships
GET /symbols/{symbol_id}
Response:
  symbol:
    id: "..."
    name: "CodeBlock"
    type: "function"
  relationships:
    imports: [...]
    called_by: [...]
    extends: [...]

# Find references to a symbol
GET /symbols/{symbol_id}/references
Response:
  references:
    - file_path: "..."
      line: 25
      column: 10
      context: "const html = codeToHtml(...)"

# Get file with its symbols
GET /files/{file_path}/symbols
Response:
  file:
    path: "..."
    language: "typescript"
  symbols: [...]

# Get import graph for a file
GET /files/{file_path}/imports?depth=2
Response:
  direct: [...]
  transitive: [...]

# Get component hierarchy
GET /graph/component-hierarchy?root=ChatInterface
Response:
  tree:
    - name: "ChatInterface"
      children:
        - name: "MessageList"
          children: [...]

# Find path between two symbols
GET /graph/path?from=CodeBlock&to=shiki
Response:
  path:
    - CodeBlock
    - codeToHtml
    - shiki

# Reindex a file or directory
POST /index
Body: {"path": "apps/oasis-ui-react/src/components"}
Response: {"indexed": 15, "removed": 0, "errors": []}

# Full reindex
POST /index/full
Response: {"indexed": 1500, "duration_ms": 45000}

# Get indexing status
GET /index/status
Response:
  total_files: 1500
  indexed_files: 1500
  pending_files: 0
  last_full_index: "2026-03-21T10:00:00Z"
```

---

## Implementation Phases

### Phase 1: Core Indexing (MVP)
- [ ] Tree-sitter parsers for TypeScript/JavaScript, Python
- [ ] Neo4j schema and indexing
- [ ] File system crawler
- [ ] Basic symbol extraction (functions, classes, interfaces)
- [ ] Import/export extraction
- [ ] REST API for queries

### Phase 2: Relationships
- [ ] Call graph analysis
- [ ] Inheritance hierarchy (extends/implements)
- [ ] Reference tracking
- [ ] Component hierarchy for React/Vue

### Phase 3: Incremental & Real-time
- [ ] File watcher with debouncing
- [ ] Incremental updates (only changed files)
- [ ] Content hash-based change detection
- [ ] Redis queue for durability

### Phase 4: Advanced Features
- [ ] Semantic search (embeddings)
- [ ] Documentation extraction
- [ ] Test coverage linking
- [ ] Cross-language references

---

## Integration with Agent

### New Tool: `query_code_knowledge`

The agent gets a new tool:

```yaml
name: query_code_knowledge
description: Query the code knowledge graph for symbols, references, and relationships
parameters:
  query_type:
    enum: [symbol_search, references, component_hierarchy, imports]
  q: string  # search query
  path: string  # optional file path filter
  limit: number
```

### Prompt Updates

Replace the misleading "Knowledge Graph is your memory" with:

```
═══ CODE KNOWLEDGE GRAPH ═══

The system maintains a code knowledge graph with:
- Symbols (functions, classes, interfaces) and their locations
- Import/export relationships
- Component hierarchies
- Call graphs

Use query_code_knowledge to:
1. Find where a symbol is defined
2. See what imports a specific module
3. Get component hierarchy
4. Find references to a function

Example workflow:
- User asks about "CodeBlock component"
- query_code_knowledge: {query_type: "symbol_search", q: "CodeBlock"}
- Returns: CodeBlock is defined in apps/oasis-ui-react/src/components/chat/CodeBlock.tsx
- Then read_file that path directly — no need for grep
```

---

## File Structure

```
services/code_indexer/
├── Dockerfile
├── requirements.txt
├── main.py                 # FastAPI app
├── service.py              # Core indexing logic
├── parsers/
│   ├── __init__.py
│   ├── base.py             # Base parser interface
│   ├── typescript.py       # Tree-sitter TS/TSX
│   ├── python.py           # Tree-sitter Python
│   └── javascript.py       # Tree-sitter JS/JSX
├── neo4j_client.py         # Neo4j connection & queries
├── indexer.py              # File crawling & indexing orchestration
├── watcher.py              # File system watcher
└── models.py               # Pydantic models
```

---

## Dependencies

```txt
# requirements.txt
fastapi==0.115.0
uvicorn[standard]==0.32.0
neo4j==5.27.0
redis==5.2.0
watchdog==6.0.0
tree-sitter==0.24.0
tree-sitter-typescript==0.23.0
tree-sitter-python==0.23.0
tree-sitter-javascript==0.23.0
pydantic==2.10.0
pydantic-settings==2.7.0
```

---

## Configuration

```python
# .env additions
OASIS_CODE_INDEXER_ENABLED=true
OASIS_CODE_INDEXER_WATCH=true
OASIS_CODE_INDEXER_INDEX_ON_START=true
OASIS_CODE_INDEXER_EXCLUDE="node_modules,*.min.js,*.d.ts,dist,build,.git"
```

---

## Success Metrics

1. **Agent Efficiency**: Reduce exploration iterations by 50%
2. **Query Latency**: Symbol search < 100ms
3. **Coverage**: Index 95%+ of source files
4. **Freshness**: Changes reflected within 5 seconds
