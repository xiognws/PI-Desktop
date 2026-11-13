//! Stamp a version resource into the Windows host binary.
//!
//! `pi-desktop-host-core.exe` shipped with an empty version resource, so
//! Explorer, Authenticode consumers and reputation services all saw an
//! anonymous executable with no publisher, product or description. The values
//! below match what the Electron side stamps, so both binaries describe the
//! same product at the same version.
//!
//! The resource is generated from `CARGO_PKG_VERSION` at build time instead of
//! being checked in, and compiled with the Windows SDK `rc.exe` directly: no
//! extra crate, so the dependency graph and `Cargo.lock` stay untouched. When
//! the SDK is absent the build still succeeds, with a warning, because a
//! missing version resource is cosmetic rather than functional.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=CARGO_PKG_VERSION");

    // A `.res` is an MS COFF object. The MSVC linker reads it; `ld` (used by the
    // GNU toolchain) rejects it as "file format not recognized", which fails the
    // whole link. Only attach the resource when the target links with MSVC — a
    // GNU developer build gets no version block, which is cosmetic.
    #[cfg(all(windows, target_env = "msvc"))]
    embed_version_resource();
}

#[cfg(all(windows, target_env = "msvc"))]
fn embed_version_resource() {
    let version = env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".to_owned());
    let mut parts = version
        .split(['.', '-', '+'])
        .map(|part| part.trim().parse::<u64>().unwrap_or(0))
        .collect::<Vec<_>>();
    parts.resize(4, 0);
    let numeric = parts[..4]
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(",");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
    let rc_file = out_dir.join("host-core-version.rc");
    let res_file = out_dir.join("host-core-version.res");

    let resource = format!(
        r#"1 VERSIONINFO
FILEVERSION {numeric}
PRODUCTVERSION {numeric}
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "Pi-Workspace"
      VALUE "FileDescription", "Pi-Workspace host core"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "pi-desktop-host-core"
      VALUE "OriginalFilename", "pi-desktop-host-core.exe"
      VALUE "ProductName", "Pi-Workspace"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#
    );
    fs::write(&rc_file, resource).expect("write generated version resource");

    let Some(rc_exe) = find_resource_compiler() else {
        println!(
            "cargo:warning=rc.exe not found; pi-desktop-host-core.exe will ship without a version resource"
        );
        return;
    };

    let status = Command::new(&rc_exe)
        .arg("/nologo")
        .arg(format!("/fo{}", res_file.display()))
        .arg(&rc_file)
        .status()
        .expect("run the Windows resource compiler");
    if !status.success() {
        println!(
            "cargo:warning=rc.exe failed; pi-desktop-host-core.exe will ship without a version resource"
        );
        return;
    }

    println!("cargo:rustc-link-arg-bins={}", res_file.display());
    println!("cargo:rerun-if-changed={}", rc_file.display());
}

/// Locate the Windows SDK resource compiler, preferring the newest SDK.
#[cfg(all(windows, target_env = "msvc"))]
fn find_resource_compiler() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for base in [
        r"C:\Program Files (x86)\Windows Kits\10\bin",
        r"C:\Program Files\Windows Kits\10\bin",
    ] {
        let base = Path::new(base);
        let Ok(entries) = fs::read_dir(base) else {
            continue;
        };
        for entry in entries.flatten() {
            let candidate = entry.path().join("x64").join("rc.exe");
            if candidate.is_file() {
                candidates.push(candidate);
            }
        }
    }
    candidates.sort();
    candidates.pop().or_else(|| find_on_path("rc.exe"))
}

#[cfg(all(windows, target_env = "msvc"))]
fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}
