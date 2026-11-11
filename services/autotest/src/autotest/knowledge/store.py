"""知识库的文档表、FTS5 索引与检索。

两张东西分工明确：

* `knowledge_docs` 记"导入了哪个文件、切成几条"，文件本体在
  `<project>/knowledge/<doc_id>/<filename>`，删文档时一起删。
* 切分后的条目仍写进 `knowledge_records`（`record_type='doc-chunk'`,
  `source_ref='doc:<doc_id>#<n>'`），所以老的检索接口不用改数据模型。

排序用 FTS5 的 BM25（`bm25()` 越小越相关）；FTS5 建不出来、或查询里有短于
3 个字符的词（trigram 分词器对 2 字中文词无能为力）时退化为 LIKE。
"""

from __future__ import annotations

import hashlib
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

DOC_SCHEMA = """
CREATE TABLE IF NOT EXISTS knowledge_docs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    format TEXT DEFAULT '',
    size INTEGER DEFAULT 0,
    module TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    chunk_count INTEGER DEFAULT 0,
    truncated INTEGER DEFAULT 0,
    sha256 TEXT DEFAULT '',
    created_at TEXT
);
"""

_FTS_TAIL = """
CREATE TRIGGER IF NOT EXISTS knowledge_fts_ai AFTER INSERT ON knowledge_records BEGIN
    INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_fts_ad AFTER DELETE ON knowledge_records BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_fts_au AFTER UPDATE ON knowledge_records BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
"""


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _fts_exists(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'"
    ).fetchone()
    return row is not None


def _create_fts(conn: sqlite3.Connection) -> None:
    body = "title, content, content='knowledge_records', content_rowid='id'"
    for tokenizer in ("trigram", "unicode61"):
        try:
            conn.execute(
                f"CREATE VIRTUAL TABLE knowledge_fts USING fts5({body}, tokenize='{tokenizer}')"
            )
            conn.executescript(_FTS_TAIL)
            # 老库里已有的条目也要进索引
            conn.execute("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')")
            return
        except sqlite3.OperationalError:
            conn.execute("DROP TABLE IF EXISTS knowledge_fts")
    # 这个 SQLite 没有 FTS5：不建索引，检索退化为 LIKE
    conn.execute("DROP TABLE IF EXISTS knowledge_fts")


def ensure_knowledge_tables(conn: sqlite3.Connection) -> None:
    """幂等：建文档表，缺失时建 FTS 索引并回填历史条目。"""
    conn.executescript(DOC_SCHEMA)
    # 老库没有去重列：补上，历史行留空串（不会被当成重复命中）
    columns = {row[1] for row in conn.execute("PRAGMA table_info(knowledge_docs)").fetchall()}
    if "sha256" not in columns:
        conn.execute("ALTER TABLE knowledge_docs ADD COLUMN sha256 TEXT DEFAULT ''")
    if not _fts_exists(conn):
        _create_fts(conn)
    backfill_sha(conn)


def backfill_sha(conn: sqlite3.Connection, limit: int = 200) -> int:
    """给丢失去重信息的老文档补 sha256。

    去重列是后加的，历史行的 `sha256` 是空串；不补的话"同一份文件再传一次"
    仍会被当成新文档。原文还在 `stored_path` 上，按原字节重算即可。
    每轮最多 `limit` 条，取不到就返回，不会在大库上卡住。
    """
    rows = conn.execute(
        "SELECT id, stored_path FROM knowledge_docs WHERE sha256 = '' LIMIT ?", (limit,)
    ).fetchall()
    filled = 0
    for doc_id, stored_path in rows:
        if not stored_path:
            continue
        path = Path(stored_path)
        try:
            if not path.is_file():
                continue
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            continue
        conn.execute("UPDATE knowledge_docs SET sha256 = ? WHERE id = ?", (digest, doc_id))
        filled += 1
    return filled


def find_document_by_sha(conn: sqlite3.Connection, project_id: str, sha256: str) -> dict | None:
    """同一个项目里已经导入过同样的字节时，返回那份文档，避免重复条目。"""
    if not sha256:
        return None
    row = conn.execute(
        "SELECT id, filename, chunk_count, format FROM knowledge_docs"
        " WHERE project_id = ? AND sha256 = ? ORDER BY created_at DESC LIMIT 1",
        (project_id, sha256),
    ).fetchone()
    if row is None:
        return None
    return {"doc_id": row[0], "filename": row[1], "chunks": row[2], "format": row[3]}


def fts_ready(conn: sqlite3.Connection) -> bool:
    return _fts_exists(conn)


def _fts_query(query: str) -> str | None:
    """把用户输入变成一个安全的 FTS 短语查询；无法表达时返回 None（走 LIKE）。

    混合查询（"读 DTC"）里短词（"读"）交给 trigram 只会匹配不到，所以只保留
    长度 ≥ 3 的词；一个都不剩才整体退化为 LIKE。
    """
    tokens = [t for t in query.split() if len(t) >= 3]
    if not tokens:
        return None
    return " ".join('"' + t.replace('"', '""') + '"' for t in tokens)


def save_document(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    filename: str,
    stored_path: str,
    file_format: str,
    size: int,
    module: str,
    tags: list[str],
    truncated: bool,
    chunks: list[tuple[str, str]],
    doc_id: str | None = None,
    sha256: str = "",
) -> str:
    """写一条文档记录 + 它的切分条目，返回 doc_id。

    `doc_id` 可由调用方先算出来（路由需要先建目录、落原文件），不传则这里生成。
    """
    doc_id = doc_id or f"doc-{uuid.uuid4().hex[:8]}"
    tags_text = ",".join(t for t in tags if t)
    conn.execute(
        "INSERT INTO knowledge_docs (id, project_id, filename, stored_path, format, size,"
        " module, tags, chunk_count, truncated, sha256, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            doc_id, project_id, filename, stored_path, file_format, size,
            module, tags_text, len(chunks), 1 if truncated else 0, sha256, _now(),
        ),
    )
    for index, (title, content) in enumerate(chunks, start=1):
        conn.execute(
            "INSERT INTO knowledge_records (project_id, module, record_type, title, content,"
            " tags, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                project_id, module, "doc-chunk", title, content, tags_text,
                f"doc:{doc_id}#{index}", _now(),
            ),
        )
    return doc_id


def list_documents(conn: sqlite3.Connection, project_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT id, filename, format, size, module, tags, chunk_count, truncated, created_at, sha256"
        " FROM knowledge_docs WHERE project_id = ? ORDER BY created_at DESC",
        (project_id,),
    ).fetchall()
    return [
        {
            "doc_id": row[0],
            "filename": row[1],
            "format": row[2],
            "size": row[3],
            "module": row[4],
            "tags": row[5],
            "chunk_count": row[6],
            "truncated": bool(row[7]),
            "created_at": row[8],
            "sha256": row[9],
        }
        for row in rows
    ]


def get_document(conn: sqlite3.Connection, project_id: str, doc_id: str) -> dict | None:
    row = conn.execute(
        "SELECT id, filename, format, size, module, tags, chunk_count, truncated, created_at, sha256,"
        " stored_path FROM knowledge_docs WHERE project_id = ? AND id = ?",
        (project_id, doc_id),
    ).fetchone()
    if row is None:
        return None
    return {
        "doc_id": row[0],
        "filename": row[1],
        "format": row[2],
        "size": row[3],
        "module": row[4],
        "tags": row[5],
        "chunk_count": row[6],
        "truncated": bool(row[7]),
        "created_at": row[8],
        "sha256": row[9],
        "stored_path": row[10],
    }


def list_document_chunks(
    conn: sqlite3.Connection,
    project_id: str,
    doc_id: str,
    limit: int = 20,
    offset: int = 0,
    max_chars: int = 1_200,
) -> dict:
    """看一份文档被切成了什么样：按序号取切分条目，正文按 max_chars 截断。"""
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    total = conn.execute(
        "SELECT COUNT(*) FROM knowledge_records WHERE project_id = ? AND source_ref LIKE ?",
        (project_id, f"doc:{doc_id}#%"),
    ).fetchone()[0]
    rows = conn.execute(
        "SELECT title, content, source_ref, tags, created_at FROM knowledge_records"
        " WHERE project_id = ? AND source_ref LIKE ? ORDER BY id ASC LIMIT ? OFFSET ?",
        (project_id, f"doc:{doc_id}#%", limit, offset),
    ).fetchall()
    chunks = [
        {
            "title": row[0],
            "excerpt": row[1] if len(row[1] or "") <= max_chars else (row[1] or "")[:max_chars] + "…",
            "chars": len(row[1] or ""),
            "source_ref": row[2],
            "tags": row[3],
            "created_at": row[4],
        }
        for row in rows
    ]
    return {"chunks": chunks, "total": int(total), "limit": limit, "offset": offset}


def delete_document(conn: sqlite3.Connection, project_id: str, doc_id: str) -> int:
    """删除文档与其条目，返回删掉的条目数。文件由调用方删（需要项目目录）。"""
    deleted = conn.execute(
        "DELETE FROM knowledge_records WHERE project_id = ? AND source_ref LIKE ?",
        (project_id, f"doc:{doc_id}#%"),
    ).rowcount
    conn.execute("DELETE FROM knowledge_docs WHERE project_id = ? AND id = ?", (project_id, doc_id))
    return int(deleted)


def search_records(
    conn: sqlite3.Connection,
    project_id: str,
    query: str = "",
    module: str = "",
    tags: str = "",
    limit: int = 20,
) -> list[dict]:
    """BM25 排序的检索；无法使用 FTS 时交给 LIKE 兜底。"""
    limit = max(1, min(limit, 200))
    fts = _fts_query(query) if query and fts_ready(conn) else None
    if fts is None:
        from autotest.workflow import store as workflow_store

        return workflow_store.search_knowledge(conn, project_id, query, module, tags, limit)

    where = ["r.project_id = ?", "knowledge_fts MATCH ?"]
    values: list[object] = [project_id, fts]
    if module:
        where.append("r.module = ?")
        values.append(module)
    if tags:
        where.append("r.tags LIKE ?")
        values.append(f"%{tags}%")
    sql = (
        "SELECT r.id, r.module, r.record_type, r.title, substr(r.content, 1, 400),"
        " r.tags, r.source_ref, r.created_at, bm25(knowledge_fts) AS score"
        f" FROM knowledge_fts JOIN knowledge_records r ON r.id = knowledge_fts.rowid"
        f" WHERE {' AND '.join(where)} ORDER BY score ASC, r.created_at DESC LIMIT ?"
    )
    try:
        rows = conn.execute(sql, (*values, limit)).fetchall()
    except sqlite3.OperationalError:
        from autotest.workflow import store as workflow_store

        return workflow_store.search_knowledge(conn, project_id, query, module, tags, limit)

    return [
        {
            "id": row[0],
            "module": row[1],
            "record_type": row[2],
            "title": row[3],
            "excerpt": row[4],
            "tags": row[5],
            "source_ref": row[6],
            "created_at": row[7],
            "score": round(float(row[8]), 4),
        }
        for row in rows
    ]
