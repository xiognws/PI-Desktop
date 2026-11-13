"""知识库的导入与管理入口。

`POST /documents` 吃文件（multipart），`POST /documents/text` 吃一段文字，
两者走同一条链路：抽文本 → 切分 → 写 knowledge_records。
原文件落在 `<project>/knowledge/<doc_id>/<filename>`，删文档时连文件和条目一起删。
"""

from __future__ import annotations

import hashlib
import shutil
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from autotest.knowledge import chunk_text, extract_text, is_supported
from autotest.knowledge import store as knowledge_store
from autotest.knowledge.extract import UnsupportedDocument

router = APIRouter(prefix="/api/projects/{project_id}/knowledge", tags=["knowledge"])


def _server():
    from autotest.api import server

    return server


@contextmanager
def _project_conn(project_id: str):
    server = _server()
    server.require_project(project_id)
    conn = sqlite3.connect(server.get_project_db(project_id))
    conn.row_factory = sqlite3.Row
    try:
        knowledge_store.ensure_knowledge_tables(conn)
        yield conn
        conn.commit()
    finally:
        conn.close()


def _project_dir(project_id: str) -> Path:
    return _server().require_project(project_id)


def _parse_tags(raw: str) -> list[str]:
    return [t.strip() for t in raw.replace("，", ",").split(",") if t.strip()]


def _store_text(
    project_id: str,
    *,
    title: str,
    text: str,
    module: str,
    tags: list[str],
    chunk_chars: int,
    filename: str = "",
    stored_path: str = "",
    file_format: str = "text",
    size: int = 0,
    doc_id: str | None = None,
    sha256: str = "",
) -> dict:
    try:
        chunks = chunk_text(text, chunk_chars)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not chunks:
        raise HTTPException(status_code=400, detail="切分结果为空，文件里没有可入库的文本")

    doc_id = doc_id or f"doc-{uuid.uuid4().hex[:8]}"
    with _project_conn(project_id) as conn:
        existing = knowledge_store.find_document_by_sha(conn, project_id, sha256)
        if existing:
            return {
                "doc_id": existing["doc_id"],
                "filename": existing["filename"],
                "format": existing["format"],
                "chunks": existing["chunks"],
                "chars": len(text),
                "skipped": True,
            }
        knowledge_store.save_document(
            conn,
            project_id=project_id,
            filename=filename or f"{title}.md",
            stored_path=stored_path,
            file_format=file_format,
            size=size,
            module=module,
            tags=tags,
            truncated=len(text) >= 3_000_000,
            chunks=[(c.title or title, c.content) for c in chunks],
            doc_id=doc_id,
            sha256=sha256,
        )
    return {
        "doc_id": doc_id,
        "filename": filename or f"{title}.md",
        "format": file_format,
        "chunks": len(chunks),
        "chars": len(text),
        "skipped": False,
    }


def _ingest_file(
    project_id: str,
    filename: str,
    raw: bytes,
    module: str = "",
    tags: str = "",
    chunk_chars: int = 1200,
) -> dict:
    """落一个文件的完整链路：校验 → 抽文本 → sha 查重 → 落原文 → 切分入库。

    单文件和批量上传共用这一条，避免两套逻辑各写一遍。
    """
    filename = Path(filename or "").name
    if not filename:
        raise HTTPException(status_code=400, detail="文件名为空")
    if not is_supported(filename):
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件类型 {Path(filename).suffix or '(无扩展名)'}",
        )

    try:
        extracted = extract_text(filename, raw)
    except UnsupportedDocument as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    sha = hashlib.sha256(raw).hexdigest()
    with _project_conn(project_id) as conn:
        existing = knowledge_store.find_document_by_sha(conn, project_id, sha)
    if existing:
        return {
            "doc_id": existing["doc_id"],
            "filename": existing["filename"],
            "format": existing["format"],
            "chunks": existing["chunks"],
            "chars": len(extracted.text),
            "truncated": extracted.truncated,
            "skipped": True,
        }

    project_dir = _project_dir(project_id)
    doc_id = f"doc-{uuid.uuid4().hex[:8]}"
    doc_dir = project_dir / "knowledge" / doc_id
    doc_dir.mkdir(parents=True, exist_ok=True)
    stored = doc_dir / filename
    stored.write_bytes(raw)

    result = _store_text(
        project_id,
        title=Path(filename).stem,
        text=extracted.text,
        module=module,
        tags=_parse_tags(tags),
        chunk_chars=chunk_chars,
        filename=filename,
        stored_path=str(stored),
        file_format=extracted.format,
        size=len(raw),
        doc_id=doc_id,
        sha256=sha,
    )
    return {**result, "truncated": extracted.truncated}


@router.post("/documents")
async def upload_document(
    project_id: str,
    file: UploadFile = File(...),
    module: str = Form(""),
    tags: str = Form(""),
    chunk_chars: int = Form(1200),
) -> dict:
    """上传一个文件并切分入库。支持 md/txt/log/csv/json/html/pdf/docx 等。"""
    filename = Path(file.filename or "").name
    raw = await file.read()
    data = _ingest_file(project_id, filename, raw, module, tags, chunk_chars)
    if data["skipped"]:
        summary = f"{filename} 与已导入的 {data['filename']} 内容相同，跳过"
    else:
        summary = f"{data['filename']} 已切分为 {data['chunks']} 条"
    return {"ok": True, "summary": summary, "data": data}


@router.post("/documents/batch")
async def upload_documents_batch(
    project_id: str,
    files: list[UploadFile] = File(...),
    module: str = Form(""),
    tags: str = Form(""),
    chunk_chars: int = Form(1200),
) -> dict:
    """一次传多个文件（可混合格式）：逐个走同一条导入链路，单个失败不影响其它。"""
    if not files:
        raise HTTPException(status_code=400, detail="没有收到文件")
    if len(files) > 50:
        raise HTTPException(status_code=400, detail="一次最多 50 个文件，请分批导入")

    imported: list[dict] = []
    skipped: list[dict] = []
    failed: list[dict] = []
    for item in files:
        filename = Path(item.filename or "").name
        try:
            raw = await item.read()
            data = _ingest_file(project_id, filename, raw, module, tags, chunk_chars)
        except HTTPException as exc:
            failed.append({"filename": filename, "error": str(exc.detail)})
            continue
        if data["skipped"]:
            skipped.append({"filename": filename, "doc_id": data["doc_id"]})
        else:
            imported.append(
                {"filename": data["filename"], "doc_id": data["doc_id"], "chunks": data["chunks"], "format": data["format"]}
            )

    return {
        "ok": True,
        "summary": f"批量导入：新增 {len(imported)}，跳过 {len(skipped)}，失败 {len(failed)}",
        "data": {"imported": imported, "skipped": skipped, "failed": failed},
    }


class TextDocumentIn(BaseModel):
    title: str
    content: str
    module: str = ""
    tags: str = ""
    chunk_chars: int = 1200


@router.post("/documents/text")
async def upload_text(project_id: str, body: TextDocumentIn) -> dict:
    """直接粘一段文字入库（会议结论、踩坑记录），不用先存文件。"""
    title = body.title.strip()
    content = body.content.strip()
    if not title or not content:
        raise HTTPException(status_code=400, detail="title 与 content 都不能为空")
    if len(content) > 3_000_000:
        raise HTTPException(status_code=400, detail="单条文本超过 3,000,000 字符")

    result = _store_text(
        project_id,
        title=title,
        text=content,
        module=body.module,
        tags=_parse_tags(body.tags),
        chunk_chars=body.chunk_chars,
        sha256=hashlib.sha256(f"text:{content}".encode()).hexdigest(),
    )
    return {
        "ok": True,
        "summary": (
            f"与已入库的 {result['filename']} 内容相同，跳过"
            if result["skipped"]
            else f"「{title}」已切分为 {result['chunks']} 条"
        ),
        "data": result,
    }


@router.get("/documents")
def list_documents(project_id: str) -> dict:
    with _project_conn(project_id) as conn:
        documents = knowledge_store.list_documents(conn, project_id)
    return {"ok": True, "data": {"documents": documents, "total": len(documents)}}


class FromSpecsIn(BaseModel):
    module: str = ""
    tags: str = ""
    chunk_chars: int = 1200


@router.post("/documents/from-specs")
def import_from_specs(project_id: str, body: FromSpecsIn) -> dict:
    """把项目 `specs/` 里已上传的项目资料一次性切分入库。

    这些文件本来就在项目目录里，不再复制一份，`stored_path` 直接指向原路径；
    内容相同的重复导入按 sha256 跳过。
    """
    project_dir = _project_dir(project_id)
    specs_dir = project_dir / "specs"
    imported: list[dict] = []
    skipped: list[str] = []
    failed: list[dict] = []

    if not specs_dir.is_dir():
        return {"ok": True, "summary": "还没有上传项目资料", "data": {"imported": [], "skipped": [], "failed": []}}

    for path in sorted(specs_dir.iterdir()):
        if not path.is_file() or not is_supported(path.name):
            continue
        try:
            raw = path.read_bytes()
            extracted = extract_text(path.name, raw)
            result = _store_text(
                project_id,
                title=path.stem,
                text=extracted.text,
                module=body.module,
                tags=_parse_tags(body.tags),
                chunk_chars=body.chunk_chars,
                filename=path.name,
                stored_path=str(path),
                file_format=extracted.format,
                size=len(raw),
                sha256=hashlib.sha256(raw).hexdigest(),
            )
        except (UnsupportedDocument, HTTPException) as exc:
            failed.append({"filename": path.name, "error": str(getattr(exc, "detail", exc))})
            continue
        if result["skipped"]:
            skipped.append(path.name)
        else:
            imported.append({"filename": path.name, "chunks": result["chunks"], "format": result["format"]})

    return {
        "ok": True,
        "summary": f"资料入库：新增 {len(imported)}，跳过 {len(skipped)}，失败 {len(failed)}",
        "data": {"imported": imported, "skipped": skipped, "failed": failed},
    }


@router.get("/documents/{doc_id}/chunks")
def list_chunks(project_id: str, doc_id: str, limit: int = 20, offset: int = 0) -> dict:
    """预览一份文档的切分结果：标题、序号、每条字符数与正文摘要。"""
    with _project_conn(project_id) as conn:
        document = knowledge_store.get_document(conn, project_id, doc_id)
        if document is None:
            raise HTTPException(status_code=404, detail=f"文档不存在: {doc_id}")
        chunks = knowledge_store.list_document_chunks(conn, project_id, doc_id, limit, offset)
    return {
        "ok": True,
        "summary": f"{document['filename']} 共 {chunks['total']} 条切分，本页 {len(chunks['chunks'])} 条",
        "data": {"document": document, **chunks},
    }


@router.get("/documents/stats")
def document_stats(project_id: str) -> dict:
    """按模块分组的文档/切分统计（知识库侧栏与导入回执共用）。"""
    with _project_conn(project_id) as conn:
        stats = knowledge_store.module_stats(conn, project_id)
    return {"ok": True, "data": stats}


class DocumentPatchIn(BaseModel):
    # None = 不改这个字段；空字符串 = 清空（未分组 / 无标签）。
    module: str | None = None
    tags: str | None = None


@router.patch("/documents/{doc_id}")
def patch_document(project_id: str, doc_id: str, body: DocumentPatchIn) -> dict:
    """改文档的模块/标签。只动元数据，不重切、不影响已有检索条目。"""
    with _project_conn(project_id) as conn:
        updated = knowledge_store.update_document(
            conn, project_id, doc_id, module=body.module, tags=body.tags
        )
    if updated is None:
        raise HTTPException(status_code=404, detail=f"文档不存在: {doc_id}")
    return {"ok": True, "summary": f"已更新 {updated['filename']}", "data": {"document": updated}}


class DeleteBatchIn(BaseModel):
    ids: list[str]


@router.post("/documents/delete-batch")
def delete_documents_batch(project_id: str, body: DeleteBatchIn) -> dict:
    """批量删除。逐个走单删路径：文件 + 条目 + 文档行要么全删，要么那一条报错。"""
    project_dir = _project_dir(project_id)
    knowledge_dir = (project_dir / "knowledge").resolve()
    deleted: list[str] = []
    failed: list[dict] = []
    chunks = 0
    for doc_id in body.ids:
        try:
            with _project_conn(project_id) as conn:
                if knowledge_store.get_document(conn, project_id, doc_id) is None:
                    failed.append({"doc_id": doc_id, "reason": "文档不存在"})
                    continue
                chunks += knowledge_store.delete_document(conn, project_id, doc_id)
            doc_dir = project_dir / "knowledge" / doc_id
            if doc_id.startswith("doc-") and knowledge_dir in doc_dir.resolve().parents and doc_dir.is_dir():
                shutil.rmtree(doc_dir, ignore_errors=True)
            deleted.append(doc_id)
        except Exception as exc:  # 单条失败不影响其余
            failed.append({"doc_id": doc_id, "reason": str(exc)})
    return {
        "ok": True,
        "summary": f"已删除 {len(deleted)} 份文档（{chunks} 条切分）"
        + (f"，{len(failed)} 份失败" if failed else ""),
        "data": {"deleted": deleted, "failed": failed, "deleted_chunks": chunks},
    }


@router.delete("/documents/{doc_id}")
def delete_document(project_id: str, doc_id: str) -> dict:
    project_dir = _project_dir(project_id)
    with _project_conn(project_id) as conn:
        deleted = knowledge_store.delete_document(conn, project_id, doc_id)

    doc_dir = project_dir / "knowledge" / doc_id
    knowledge_dir = (project_dir / "knowledge").resolve()
    if doc_id.startswith("doc-") and knowledge_dir in doc_dir.resolve().parents and doc_dir.is_dir():
        shutil.rmtree(doc_dir, ignore_errors=True)
    return {
        "ok": True,
        "summary": f"已删除 {deleted} 条切分记录",
        "data": {"doc_id": doc_id, "deleted_chunks": deleted},
    }
