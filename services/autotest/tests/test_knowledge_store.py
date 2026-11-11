"""知识库存储层：去重列的历史数据回填。"""

import hashlib
import sqlite3

from autotest.knowledge import store


def test_backfill_fills_sha_for_legacy_rows(tmp_path):
    conn = sqlite3.connect(tmp_path / "db.sqlite")
    conn.row_factory = sqlite3.Row
    store.ensure_knowledge_tables(conn)

    original = tmp_path / "legacy.md"
    original.write_bytes("老文档".encode())

    conn.execute(
        "INSERT INTO knowledge_docs (id, project_id, filename, stored_path, format, size,"
        " module, tags, chunk_count, truncated, sha256, created_at)"
        " VALUES ('doc-legacy', 'p1', 'legacy.md', ?, 'md', 9, '', '', 1, 0, '', '2026-01-01')",
        (str(original),),
    )
    conn.commit()

    assert store.find_document_by_sha(conn, "p1", hashlib.sha256(original.read_bytes()).hexdigest()) is None
    store.backfill_sha(conn)
    conn.commit()

    hit = store.find_document_by_sha(conn, "p1", hashlib.sha256(original.read_bytes()).hexdigest())
    assert hit is not None
    assert hit["doc_id"] == "doc-legacy"


def test_backfill_skips_rows_whose_file_is_gone(tmp_path):
    conn = sqlite3.connect(tmp_path / "db.sqlite")
    conn.row_factory = sqlite3.Row
    store.ensure_knowledge_tables(conn)

    conn.execute(
        "INSERT INTO knowledge_docs (id, project_id, filename, stored_path, format, size,"
        " module, tags, chunk_count, truncated, sha256, created_at)"
        " VALUES ('doc-ghost', 'p1', 'gone.md', ?, 'md', 0, '', '', 0, 0, '', '2026-01-01')",
        (str(tmp_path / "gone.md"),),
    )
    conn.commit()

    assert store.backfill_sha(conn) == 0
