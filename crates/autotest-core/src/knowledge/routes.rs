//! Knowledge HTTP routes — mounted at `/api/projects/{project_id}/knowledge`.
//!
//! Ported from `autotest/api/knowledge_routes.py`. `POST /documents` takes a
//! file, `POST /documents/text` takes pasted text, and both go through one
//! pipeline: extract → chunk → write `knowledge_records`. The original file
//! lands in `<project>/knowledge/<doc_id>/<filename>` and is deleted with the
//! document, so the project directory stays the single source of truth.
//!
//! Every response is `{ok, summary, data}` shaped exactly as the FastAPI routes
//! built it, because the workbench renders `summary` verbatim.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Multipart, Path as UrlPath, Query, State};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use rusqlite::Connection;
use serde_json::{json, Value};

use super::text::char_len;
use super::{chunk, extract, sha256, store};
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::project;
use crate::state::AppState;

const DEFAULT_CHUNK_CHARS: i64 = 1200;
const MAX_TEXT_CHARS: usize = 3_000_000;
const MAX_BATCH_FILES: usize = 50;

pub fn build() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/projects/:project_id/knowledge/documents",
            get(list_documents).post(upload_document),
        )
        .route(
            "/api/projects/:project_id/knowledge/documents/batch",
            post(upload_batch),
        )
        .route(
            "/api/projects/:project_id/knowledge/documents/text",
            post(upload_text),
        )
        .route(
            "/api/projects/:project_id/knowledge/documents/from-specs",
            post(import_from_specs),
        )
        .route(
            "/api/projects/:project_id/knowledge/documents/stats",
            get(document_stats),
        )
        .route(
            "/api/projects/:project_id/knowledge/documents/delete-batch",
            post(delete_batch),
        )
        .route(
            "/api/projects/:project_id/knowledge/documents/:doc_id",
            patch(patch_document).delete(delete_document),
        )
        .route(
            "/api/projects/:project_id/knowledge/documents/:doc_id/chunks",
            get(list_chunks),
        )
}

/// The project directory and its database, with the knowledge tables present.
struct ProjectContext {
    dir: PathBuf,
    conn: Connection,
}

fn open_project(state: &AppState, project_id: &str) -> ApiResult<ProjectContext> {
    let paths = state.paths();
    let dir = project::require_project(&paths.workspace, project_id)?;
    let db_path = paths.project_db(project_id)?;
    let conn = if db_path.exists() {
        db::open(&db_path)?
    } else {
        db::ensure_project_db(&dir)?
    };
    store::ensure_knowledge_tables(&conn)?;
    Ok(ProjectContext { dir, conn })
}

/// `Path(filename).name`: the last path segment on either separator, because the
/// browser sends whatever the user picked and that may include a directory.
fn basename(filename: &str) -> String {
    filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(filename)
        .to_string()
}

/// `Path(filename).stem`.
fn file_stem(filename: &str) -> String {
    match filename.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => filename.to_string(),
    }
}

fn parse_tags(raw: &str) -> Vec<String> {
    raw.replace('，', ",")
        .split(',')
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect()
}

fn new_doc_id() -> String {
    format!("doc-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

fn not_found_document(doc_id: &str) -> ApiError {
    ApiError::not_found(format!("文档不存在: {doc_id}"))
}

fn form_int(raw: &str, field: &str) -> ApiResult<i64> {
    raw.trim()
        .parse::<i64>()
        .map_err(|_| ApiError::bad_request(format!("{field} 必须是整数")))
}

fn query_int(query: &HashMap<String, String>, field: &str, default: i64) -> ApiResult<i64> {
    match query.get(field) {
        Some(raw) => form_int(raw, field),
        None => Ok(default),
    }
}

fn body_int(body: &Value, field: &str, default: i64) -> i64 {
    match body.get(field) {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(default),
        Some(Value::String(raw)) => raw.trim().parse::<i64>().unwrap_or(default),
        _ => default,
    }
}

fn body_str<'a>(body: &'a Value, field: &str) -> &'a str {
    body.get(field).and_then(Value::as_str).unwrap_or("")
}

struct StoreText<'a> {
    title: &'a str,
    body: &'a str,
    module: &'a str,
    tags: &'a [String],
    chunk_chars: i64,
    filename: &'a str,
    stored_path: &'a str,
    file_format: &'a str,
    size: i64,
    doc_id: &'a str,
    sha256: &'a str,
}

/// Shared tail of every import: chunk, dedupe by digest, write rows.
fn store_text(
    context: &ProjectContext,
    project_id: &str,
    input: StoreText<'_>,
) -> ApiResult<Value> {
    let chunks = chunk::chunk_text(input.body, input.chunk_chars).map_err(ApiError::bad_request)?;
    if chunks.is_empty() {
        return Err(ApiError::bad_request(
            "切分结果为空，文件里没有可入库的文本",
        ));
    }
    let chars = char_len(input.body);

    if let Some(existing) = store::find_document_by_sha(&context.conn, project_id, input.sha256)? {
        return Ok(json!({
            "doc_id": existing.doc_id,
            "filename": existing.filename,
            "format": existing.format,
            "chunks": existing.chunks,
            "chars": chars,
            "skipped": true,
        }));
    }

    let filename = if input.filename.is_empty() {
        format!("{}.md", input.title)
    } else {
        input.filename.to_string()
    };
    let pairs: Vec<(String, String)> = chunks
        .iter()
        .map(|item| {
            let title = if item.title.is_empty() {
                input.title.to_string()
            } else {
                item.title.clone()
            };
            (title, item.content.clone())
        })
        .collect();
    store::save_document(
        &context.conn,
        store::NewDocument {
            project_id,
            filename: &filename,
            stored_path: input.stored_path,
            file_format: input.file_format,
            size: input.size,
            module: input.module,
            tags: input.tags,
            truncated: chars >= MAX_TEXT_CHARS,
            chunks: &pairs,
            doc_id: input.doc_id,
            sha256: input.sha256,
        },
    )?;

    Ok(json!({
        "doc_id": input.doc_id,
        "filename": filename,
        "format": input.file_format,
        "chunks": chunks.len(),
        "chars": chars,
        "skipped": false,
    }))
}

/// One file's full pipeline: validate → extract → dedupe → store the original →
/// chunk into the database. Single upload and batch share it.
fn ingest_file(
    state: &AppState,
    project_id: &str,
    filename: &str,
    raw: &[u8],
    module: &str,
    tags: &str,
    chunk_chars: i64,
) -> ApiResult<Value> {
    let filename = basename(filename);
    if filename.is_empty() {
        return Err(ApiError::bad_request("文件名为空"));
    }
    if !extract::is_supported(&filename) {
        let suffix = extract::suffix_of(&filename);
        let shown = if suffix.is_empty() {
            "(无扩展名)".to_string()
        } else {
            suffix
        };
        return Err(ApiError::bad_request(format!("不支持的文件类型 {shown}")));
    }
    let extracted = extract::extract_text(&filename, raw).map_err(ApiError::bad_request)?;
    let digest = sha256::hex_digest(raw);

    let context = open_project(state, project_id)?;
    if let Some(existing) = store::find_document_by_sha(&context.conn, project_id, &digest)? {
        return Ok(json!({
            "doc_id": existing.doc_id,
            "filename": existing.filename,
            "format": existing.format,
            "chunks": existing.chunks,
            "chars": char_len(&extracted.text),
            "truncated": extracted.truncated,
            "skipped": true,
        }));
    }

    let doc_id = new_doc_id();
    let doc_dir = context.dir.join("knowledge").join(&doc_id);
    std::fs::create_dir_all(&doc_dir)?;
    let stored = doc_dir.join(&filename);
    std::fs::write(&stored, raw)?;

    let parsed_tags = parse_tags(tags);
    let title = file_stem(&filename);
    let stored_path = stored.to_string_lossy().to_string();
    let mut result = store_text(
        &context,
        project_id,
        StoreText {
            title: &title,
            body: &extracted.text,
            module,
            tags: &parsed_tags,
            chunk_chars,
            filename: &filename,
            stored_path: &stored_path,
            file_format: &extracted.format,
            size: raw.len() as i64,
            doc_id: &doc_id,
            sha256: &digest,
        },
    )?;
    if let Value::Object(map) = &mut result {
        map.insert("truncated".to_string(), Value::from(extracted.truncated));
    }
    Ok(result)
}

/// `POST /documents` — multipart upload of one file.
pub async fn upload_document(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    let mut uploaded: Option<(String, Vec<u8>)> = None;
    let mut module = String::new();
    let mut tags = String::new();
    let mut chunk_chars = DEFAULT_CHUNK_CHARS;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?
    {
        let name = field.name().unwrap_or_default().to_string();
        match name.as_str() {
            "file" => {
                let filename = field.file_name().unwrap_or_default().to_string();
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|error| ApiError::bad_request(error.to_string()))?;
                uploaded = Some((filename, bytes.to_vec()));
            }
            "module" => module = field.text().await.unwrap_or_default(),
            "tags" => tags = field.text().await.unwrap_or_default(),
            "chunk_chars" => {
                let raw = field.text().await.unwrap_or_default();
                chunk_chars = form_int(&raw, "chunk_chars")?;
            }
            _ => {}
        }
    }

    let Some((filename, raw)) = uploaded else {
        return Err(ApiError::bad_request("没有收到文件"));
    };
    let data = ingest_file(
        &state,
        &project_id,
        &filename,
        &raw,
        &module,
        &tags,
        chunk_chars,
    )?;
    let summary = if data["skipped"].as_bool().unwrap_or(false) {
        format!(
            "{} 与已导入的 {} 内容相同，跳过",
            basename(&filename),
            data["filename"].as_str().unwrap_or("")
        )
    } else {
        format!(
            "{} 已切分为 {} 条",
            data["filename"].as_str().unwrap_or(""),
            data["chunks"].as_i64().unwrap_or(0)
        )
    };
    Ok(Json(
        json!({ "ok": true, "summary": summary, "data": data }),
    ))
}

/// `POST /documents/batch` — mixed formats, one failure does not stop the rest.
pub async fn upload_batch(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    let mut uploads: Vec<(String, Vec<u8>)> = Vec::new();
    let mut module = String::new();
    let mut tags = String::new();
    let mut chunk_chars = DEFAULT_CHUNK_CHARS;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?
    {
        let name = field.name().unwrap_or_default().to_string();
        match name.as_str() {
            "files" | "file" => {
                let filename = field.file_name().unwrap_or_default().to_string();
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|error| ApiError::bad_request(error.to_string()))?;
                uploads.push((filename, bytes.to_vec()));
            }
            "module" => module = field.text().await.unwrap_or_default(),
            "tags" => tags = field.text().await.unwrap_or_default(),
            "chunk_chars" => {
                let raw = field.text().await.unwrap_or_default();
                chunk_chars = form_int(&raw, "chunk_chars")?;
            }
            _ => {}
        }
    }

    if uploads.is_empty() {
        return Err(ApiError::bad_request("没有收到文件"));
    }
    if uploads.len() > MAX_BATCH_FILES {
        return Err(ApiError::bad_request(format!(
            "一次最多 {MAX_BATCH_FILES} 个文件，请分批导入"
        )));
    }

    let mut imported: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    for (filename, raw) in uploads {
        let name = basename(&filename);
        match ingest_file(
            &state,
            &project_id,
            &name,
            &raw,
            &module,
            &tags,
            chunk_chars,
        ) {
            Ok(data) => {
                if data["skipped"].as_bool().unwrap_or(false) {
                    skipped.push(json!({ "filename": name, "doc_id": data["doc_id"] }));
                } else {
                    imported.push(json!({
                        "filename": data["filename"],
                        "doc_id": data["doc_id"],
                        "chunks": data["chunks"],
                        "format": data["format"],
                    }));
                }
            }
            Err(error) => failed.push(json!({ "filename": name, "error": error.detail })),
        }
    }

    Ok(Json(json!({
        "ok": true,
        "summary": format!(
            "批量导入：新增 {}，跳过 {}，失败 {}",
            imported.len(),
            skipped.len(),
            failed.len()
        ),
        "data": { "imported": imported, "skipped": skipped, "failed": failed },
    })))
}

/// `POST /documents/text` — paste a paragraph (a meeting decision, a trap).
pub async fn upload_text(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let title = body_str(&body, "title").trim().to_string();
    let content = body_str(&body, "content").trim().to_string();
    if title.is_empty() || content.is_empty() {
        return Err(ApiError::bad_request("title 与 content 都不能为空"));
    }
    if char_len(&content) > MAX_TEXT_CHARS {
        return Err(ApiError::bad_request(format!(
            "单条文本超过 {MAX_TEXT_CHARS} 字符"
        )));
    }

    let context = open_project(&state, &project_id)?;
    let digest = sha256::hex_digest(format!("text:{content}").as_bytes());
    let tags = parse_tags(body_str(&body, "tags"));
    let doc_id = new_doc_id();
    let result = store_text(
        &context,
        &project_id,
        StoreText {
            title: &title,
            body: &content,
            module: body_str(&body, "module"),
            tags: &tags,
            chunk_chars: body_int(&body, "chunk_chars", DEFAULT_CHUNK_CHARS),
            filename: "",
            stored_path: "",
            file_format: "text",
            size: 0,
            doc_id: &doc_id,
            sha256: &digest,
        },
    )?;

    let summary = if result["skipped"].as_bool().unwrap_or(false) {
        format!(
            "与已入库的 {} 内容相同，跳过",
            result["filename"].as_str().unwrap_or("")
        )
    } else {
        format!(
            "「{title}」已切分为 {} 条",
            result["chunks"].as_i64().unwrap_or(0)
        )
    };
    Ok(Json(
        json!({ "ok": true, "summary": summary, "data": result }),
    ))
}

/// `GET /documents`
pub async fn list_documents(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let context = open_project(&state, &project_id)?;
    let documents = store::list_documents(&context.conn, &project_id)?;
    let total = documents.len();
    Ok(Json(json!({
        "ok": true,
        "data": { "documents": documents, "total": total },
    })))
}

/// `POST /documents/from-specs` — chunk the project's own `specs/` directory.
/// Those files already live in the project, so `stored_path` points at the
/// original instead of at a copy.
pub async fn import_from_specs(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let context = open_project(&state, &project_id)?;
    let specs_dir = context.dir.join("specs");
    if !specs_dir.is_dir() {
        return Ok(Json(json!({
            "ok": true,
            "summary": "还没有上传项目资料",
            "data": { "imported": [], "skipped": [], "failed": [] },
        })));
    }

    let mut entries: Vec<PathBuf> = std::fs::read_dir(&specs_dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();
    entries.sort();

    let module = body_str(&body, "module").to_string();
    let tags = parse_tags(body_str(&body, "tags"));
    let chunk_chars = body_int(&body, "chunk_chars", DEFAULT_CHUNK_CHARS);

    let mut imported: Vec<Value> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    for path in entries {
        if !path.is_file() {
            continue;
        }
        let Some(name) = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
        else {
            continue;
        };
        if !extract::is_supported(&name) {
            continue;
        }
        let outcome = (|| -> ApiResult<Value> {
            let raw = std::fs::read(&path)?;
            let extracted = extract::extract_text(&name, &raw).map_err(ApiError::bad_request)?;
            let digest = sha256::hex_digest(&raw);
            let doc_id = new_doc_id();
            let title = file_stem(&name);
            let stored_path = path.to_string_lossy().to_string();
            store_text(
                &context,
                &project_id,
                StoreText {
                    title: &title,
                    body: &extracted.text,
                    module: &module,
                    tags: &tags,
                    chunk_chars,
                    filename: &name,
                    stored_path: &stored_path,
                    file_format: &extracted.format,
                    size: raw.len() as i64,
                    doc_id: &doc_id,
                    sha256: &digest,
                },
            )
        })();
        match outcome {
            Ok(result) => {
                if result["skipped"].as_bool().unwrap_or(false) {
                    skipped.push(name);
                } else {
                    imported.push(json!({
                        "filename": name,
                        "chunks": result["chunks"],
                        "format": result["format"],
                    }));
                }
            }
            Err(error) => failed.push(json!({ "filename": name, "error": error.detail })),
        }
    }

    Ok(Json(json!({
        "ok": true,
        "summary": format!(
            "资料入库：新增 {}，跳过 {}，失败 {}",
            imported.len(),
            skipped.len(),
            failed.len()
        ),
        "data": { "imported": imported, "skipped": skipped, "failed": failed },
    })))
}

/// `GET /documents/{doc_id}/chunks`
pub async fn list_chunks(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, doc_id)): UrlPath<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let limit = query_int(&query, "limit", 20)?;
    let offset = query_int(&query, "offset", 0)?;

    let context = open_project(&state, &project_id)?;
    let document = store::get_document(&context.conn, &project_id, &doc_id)?
        .ok_or_else(|| not_found_document(&doc_id))?;
    let page = store::list_document_chunks(&context.conn, &project_id, &doc_id, limit, offset)?;

    let total = page["total"].as_i64().unwrap_or(0);
    let on_page = page["chunks"].as_array().map(Vec::len).unwrap_or(0);
    let filename = document
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut data = serde_json::Map::new();
    data.insert("document".to_string(), document);
    if let Value::Object(rest) = page {
        for (key, value) in rest {
            data.insert(key, value);
        }
    }
    Ok(Json(json!({
        "ok": true,
        "summary": format!("{filename} 共 {total} 条切分，本页 {on_page} 条"),
        "data": Value::Object(data),
    })))
}

/// `GET /documents/stats`
pub async fn document_stats(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let context = open_project(&state, &project_id)?;
    let stats = store::module_stats(&context.conn, &project_id)?;
    Ok(Json(json!({ "ok": true, "data": stats })))
}

/// `PATCH /documents/{doc_id}` — module/tags only; chunks and search rows stay.
pub async fn patch_document(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, doc_id)): UrlPath<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let module = body.get("module").and_then(Value::as_str);
    let tags = body.get("tags").and_then(Value::as_str);

    let context = open_project(&state, &project_id)?;
    let updated = store::update_document(&context.conn, &project_id, &doc_id, module, tags)?
        .ok_or_else(|| not_found_document(&doc_id))?;
    Ok(Json(json!({
        "ok": true,
        "summary": format!("已更新 {}", updated["filename"].as_str().unwrap_or("")),
        "data": { "document": updated },
    })))
}

fn remove_document_dir(project_dir: &Path, doc_id: &str) {
    // Only a generated document directory is removed: the id is a path segment,
    // so an id from the request must never reach a directory that is not its own.
    if !doc_id.starts_with("doc-") {
        return;
    }
    let knowledge_dir = project_dir.join("knowledge");
    let doc_dir = knowledge_dir.join(doc_id);
    let (Ok(resolved_doc), Ok(resolved_knowledge)) =
        (doc_dir.canonicalize(), knowledge_dir.canonicalize())
    else {
        return;
    };
    if resolved_doc.parent() == Some(resolved_knowledge.as_path()) && resolved_doc.is_dir() {
        let _ = std::fs::remove_dir_all(&resolved_doc);
    }
}

/// `POST /documents/delete-batch` — each id goes through the single delete path,
/// so a document's file, chunks and row are removed together or not at all.
pub async fn delete_batch(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ids: Vec<String> = body
        .get("ids")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let context = open_project(&state, &project_id)?;
    let mut deleted: Vec<String> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    let mut chunks = 0i64;
    for doc_id in ids {
        match store::get_document(&context.conn, &project_id, &doc_id) {
            Ok(None) => {
                failed.push(json!({ "doc_id": doc_id, "reason": "文档不存在" }));
                continue;
            }
            Ok(Some(_)) => {}
            Err(error) => {
                failed.push(json!({ "doc_id": doc_id, "reason": error.detail }));
                continue;
            }
        }
        match store::delete_document(&context.conn, &project_id, &doc_id) {
            Ok(count) => {
                chunks += count;
                remove_document_dir(&context.dir, &doc_id);
                deleted.push(doc_id);
            }
            Err(error) => failed.push(json!({ "doc_id": doc_id, "reason": error.detail })),
        }
    }

    let mut summary = format!("已删除 {} 份文档（{} 条切分）", deleted.len(), chunks);
    if !failed.is_empty() {
        summary.push_str(&format!("，{} 份失败", failed.len()));
    }
    Ok(Json(json!({
        "ok": true,
        "summary": summary,
        "data": { "deleted": deleted, "failed": failed, "deleted_chunks": chunks },
    })))
}

/// `DELETE /documents/{doc_id}` — deleting an unknown id removes nothing and
/// still answers 200 with 0, exactly as the Python route did.
pub async fn delete_document(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, doc_id)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let context = open_project(&state, &project_id)?;
    let deleted = store::delete_document(&context.conn, &project_id, &doc_id)?;
    remove_document_dir(&context.dir, &doc_id);
    Ok(Json(json!({
        "ok": true,
        "summary": format!("已删除 {deleted} 条切分记录"),
        "data": { "doc_id": doc_id, "deleted_chunks": deleted },
    })))
}
