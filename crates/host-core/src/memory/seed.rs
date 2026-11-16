//! Facts about this installation that every conversation needs.
//!
//! Three of them, pinned and global: the platform this build runs on, where
//! runtime temp files belong, and that the product speaks Chinese to the user.
//! They are conventions of the installation rather than anything the agent
//! learned, so they are stored as imported rows at full confidence.
//!
//! `remember()` dedupes on the content hash, so seeding on every boot keeps them
//! present without duplicating rows. A customer who deletes one gets it back on
//! the next start: "fixed" means exactly that, and the memory pane shows them as
//! pinned so the intent is visible.

use std::path::Path;

use anyhow::Result;

use crate::db::Database;
use crate::memory::{MemoryKind, MemoryScope, MemorySource, NewMemory};

/// Tag that marks a row as belonging to the installation seed rather than to the
/// agent or the customer. Lets the memory pane and future tooling tell them apart.
pub const INSTALLATION_TAG: &str = "installation";

/// Human-readable platform name for the current build.
fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        other => other,
    }
}

/// The three facts, built for this installation and this data directory.
fn installation_facts(data_dir: &Path) -> Vec<(MemoryKind, String, String)> {
    let platform = platform_name();
    let tmp = data_dir.join("tmp");
    vec![
        (
            MemoryKind::Fact,
            format!("运行平台：{platform}"),
            format!(
                "本客户端运行在 {platform} 上。涉及路径、shell、进程、临时目录、快捷方式、文件锁的实现与说明一律按 {platform} 的事实来，不要套用其他系统的习惯。"
            ),
        ),
        (
            MemoryKind::Preference,
            "临时文件写在数据目录的 tmp 下".to_string(),
            format!(
                "客户端运行时产生的临时文件（下载中间文件、解压产物、交给外部工具使用的脚本等）一律写入 {} 下，用完即删；不要写到系统临时目录、工作区或用户目录。",
                tmp.display()
            ),
        ),
        (
            MemoryKind::Preference,
            "对外一律中文".to_string(),
            "与用户交流一律使用中文：对话回复、计划、总结、报错解释、界面文案都用中文；代码、标识符、注释、日志与协议字段保持英文。".to_string(),
        ),
    ]
}

/// Make sure the installation facts exist. Returns how many rows the call wrote
/// (a fresh database seeds all of them; a second boot only refreshes timestamps).
pub fn seed_installation_facts(db: &Database, data_dir: &Path) -> Result<usize> {
    let mut written = 0;
    for (kind, title, body) in installation_facts(data_dir) {
        let mut memory = NewMemory::new(MemoryScope::Global, kind, title, body)
            .with_tags(vec![INSTALLATION_TAG.to_string()])
            .pinned(true);
        // Shipped with the installation, not learned and not stated by the
        // customer: full confidence, and the UI can label it as such.
        memory.source = MemorySource::Import;
        memory.confidence = 1.0;
        db.remember(memory)?;
        written += 1;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn db() -> (Database, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (db, dir)
    }

    fn seeded(db: &Database) -> Vec<(String, String, bool, String)> {
        let mut statement = db
            .conn
            .prepare(
                "SELECT title, body, pinned, source FROM memories
                  WHERE scope = 'global' AND superseded_by IS NULL ORDER BY title",
            )
            .unwrap();
        statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get::<_, i64>(2)? != 0,
                    row.get(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn seeds_the_three_installation_facts_once() {
        let (db, dir) = db();
        let data_dir = dir.path().join("data");

        assert_eq!(seed_installation_facts(&db, &data_dir).unwrap(), 3);
        let rows = seeded(&db);
        assert_eq!(rows.len(), 3, "three fixed memories, no duplicates");

        for (_, _, pinned, source) in &rows {
            assert!(*pinned, "every installation fact is pinned");
            assert_eq!(source, "import", "they ship with the installation");
        }

        // Idempotent: the second boot must not add rows.
        seed_installation_facts(&db, &data_dir).unwrap();
        assert_eq!(seeded(&db).len(), 3);
    }

    #[test]
    fn the_temp_fact_names_the_real_data_directory() {
        let (db, dir) = db();
        let data_dir = dir.path().join("data");
        seed_installation_facts(&db, &data_dir).unwrap();

        let body = seeded(&db)
            .into_iter()
            .find(|(title, _, _, _)| title.contains("tmp"))
            .map(|(_, body, _, _)| body)
            .expect("a temp-file fact exists");
        assert!(
            body.contains(&data_dir.join("tmp").display().to_string()),
            "the fact must point at the data directory's tmp, not a placeholder: {body}"
        );
    }

    #[test]
    fn the_platform_fact_matches_the_running_build() {
        let (db, dir) = db();
        seed_installation_facts(&db, &dir.path().join("data")).unwrap();
        let rows = seeded(&db);
        let platform = rows
            .iter()
            .find(|(title, _, _, _)| title.starts_with("运行平台"))
            .map(|(_, body, _, _)| body.clone())
            .expect("a platform fact exists");
        assert!(platform.contains(platform_name()), "{platform}");
    }

    #[test]
    fn a_deleted_fact_comes_back_on_the_next_boot() {
        let (db, dir) = db();
        let data_dir = dir.path().join("data");
        seed_installation_facts(&db, &data_dir).unwrap();
        db.conn
            .execute("DELETE FROM memories WHERE title LIKE '%tmp%'", [])
            .unwrap();
        assert_eq!(seeded(&db).len(), 2);

        seed_installation_facts(&db, &data_dir).unwrap();
        assert_eq!(
            seeded(&db).len(),
            3,
            "the installation facts are not optional"
        );
    }
}
