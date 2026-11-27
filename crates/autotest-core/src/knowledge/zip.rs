//! Minimal ZIP reader: just enough to pull one member out of a `.docx`/`.xlsx`.
//!
//! Office files are ZIP archives. The service needs `word/document.xml`,
//! `xl/workbook.xml` and the sheet parts, so the reader walks the central
//! directory, honours the local header's real data offset (an archiver may put
//! an extra field there), and hands the member to `inflate` when it is deflated.
//! Encryption and ZIP64 are refused with a readable message.

use super::inflate::inflate;

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;
const LOCAL_SIGNATURE: u32 = 0x0403_4b50;
const EOCD_MIN_LEN: usize = 22;

fn u16_at(data: &[u8], offset: usize) -> Option<u16> {
    let bytes = data.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn u32_at(data: &[u8], offset: usize) -> Option<u32> {
    let bytes = data.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn find_end_of_central_directory(data: &[u8]) -> Result<usize, String> {
    if data.len() < EOCD_MIN_LEN {
        return Err("不是有效的 ZIP 文件（长度不足）".to_string());
    }
    let earliest = data.len().saturating_sub(EOCD_MIN_LEN + u16::MAX as usize);
    let mut offset = data.len() - EOCD_MIN_LEN;
    loop {
        if u32_at(data, offset) == Some(EOCD_SIGNATURE) {
            return Ok(offset);
        }
        if offset == earliest {
            return Err("不是有效的 ZIP 文件（找不到中央目录）".to_string());
        }
        offset -= 1;
    }
}

/// Read one member as raw bytes, decompressing it when needed.
pub fn read_entry(data: &[u8], wanted: &str) -> Result<Option<Vec<u8>>, String> {
    let eocd = find_end_of_central_directory(data)?;
    let entries = u16_at(data, eocd + 10).ok_or("ZIP 中央目录损坏")? as usize;
    let mut offset = u32_at(data, eocd + 16).ok_or("ZIP 中央目录损坏")? as usize;

    for _ in 0..entries {
        if u32_at(data, offset) != Some(CENTRAL_SIGNATURE) {
            return Err("ZIP 中央目录条目损坏".to_string());
        }
        let method = u16_at(data, offset + 10).ok_or("ZIP 条目损坏")?;
        let compressed_size = u32_at(data, offset + 20).ok_or("ZIP 条目损坏")? as usize;
        let name_len = u16_at(data, offset + 28).ok_or("ZIP 条目损坏")? as usize;
        let extra_len = u16_at(data, offset + 30).ok_or("ZIP 条目损坏")? as usize;
        let comment_len = u16_at(data, offset + 32).ok_or("ZIP 条目损坏")? as usize;
        let local_offset = u32_at(data, offset + 42).ok_or("ZIP 条目损坏")? as usize;
        let name_start = offset + 46;
        let name = data
            .get(name_start..name_start + name_len)
            .ok_or("ZIP 条目名称损坏")?;
        offset = name_start + name_len + extra_len + comment_len;

        if String::from_utf8_lossy(name) != wanted {
            continue;
        }
        if u32_at(data, local_offset) != Some(LOCAL_SIGNATURE) {
            return Err("ZIP 本地头损坏".to_string());
        }
        let local_name_len = u16_at(data, local_offset + 26).ok_or("ZIP 本地头损坏")? as usize;
        let local_extra_len = u16_at(data, local_offset + 28).ok_or("ZIP 本地头损坏")? as usize;
        let data_start = local_offset + 30 + local_name_len + local_extra_len;
        let raw = data
            .get(data_start..data_start + compressed_size)
            .ok_or("ZIP 成员数据被截断")?;
        return match method {
            0 => Ok(Some(raw.to_vec())),
            8 => inflate(raw).map(Some),
            other => Err(format!("ZIP 压缩方式 {other} 不支持")),
        };
    }
    Ok(None)
}

/// Names of every member, in central-directory order.
#[cfg_attr(not(test), allow(dead_code))]
pub fn entry_names(data: &[u8]) -> Result<Vec<String>, String> {
    let eocd = find_end_of_central_directory(data)?;
    let entries = u16_at(data, eocd + 10).ok_or("ZIP 中央目录损坏")? as usize;
    let mut offset = u32_at(data, eocd + 16).ok_or("ZIP 中央目录损坏")? as usize;
    let mut names = Vec::new();
    for _ in 0..entries {
        if u32_at(data, offset) != Some(CENTRAL_SIGNATURE) {
            return Err("ZIP 中央目录条目损坏".to_string());
        }
        let name_len = u16_at(data, offset + 28).ok_or("ZIP 条目损坏")? as usize;
        let extra_len = u16_at(data, offset + 30).ok_or("ZIP 条目损坏")? as usize;
        let comment_len = u16_at(data, offset + 32).ok_or("ZIP 条目损坏")? as usize;
        let name_start = offset + 46;
        let name = data
            .get(name_start..name_start + name_len)
            .ok_or("ZIP 条目名称损坏")?;
        names.push(String::from_utf8_lossy(name).into_owned());
        offset = name_start + name_len + extra_len + comment_len;
    }
    Ok(names)
}

/// Test-only ZIP writer: stored members, no CRC, enough for the extractor.
#[cfg(test)]
pub fn build_stored_zip(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<(String, usize, usize)> = Vec::new();
    for (name, body, _deflate) in entries {
        let offset = out.len();
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(body);
        central.push(((*name).to_string(), body.len(), offset));
    }
    let central_start = out.len();
    for (name, size, offset) in &central {
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(*size as u32).to_le_bytes());
        out.extend_from_slice(&(*size as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(*offset as u32).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
    }
    let central_size = out.len() - central_start;
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(central.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central_size as u32).to_le_bytes());
    out.extend_from_slice(&(central_start as u32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::{entry_names, read_entry};

    fn unhex(text: &str) -> Vec<u8> {
        let bytes = text.as_bytes();
        let mut out = Vec::with_capacity(bytes.len() / 2);
        for pair in bytes.chunks(2) {
            let high = (pair[0] as char).to_digit(16).expect("hex") as u8;
            let low = (pair[1] as char).to_digit(16).expect("hex") as u8;
            out.push((high << 4) | low);
        }
        out
    }

    /// zipfile.ZipFile over two members: one deflated, one stored.
    const SAMPLE: &str =
        "504b0304140000000800c9627b5dc11c1b571a0000002100000011000000776f72642f646f637\
56d656e742e786d6cb329b74ac94f2ecd4dcd2bb14b494dcb492c494db1d147120400504b0304140000000000c9\
627b5da265ef0907000000070000000a00000073746f7265642e74787473746f72656421504b01021400140000\
000800c9627b5dc11c1b571a00000021000000110000000000000000000000800100000000776f72642f646f63\
756d656e742e786d6c504b01021400140000000000c9627b5da265ef0907000000070000000a00000000000000\
0000000080014900000073746f7265642e747874504b0506000000000200020077000000780000000000";

    #[test]
    fn reads_a_deflated_member() {
        let zip = unhex(SAMPLE);
        let body = read_entry(&zip, "word/document.xml")
            .expect("read")
            .expect("member");
        assert_eq!(body, b"<w:document>deflated</w:document>");
    }

    #[test]
    fn reads_a_stored_member_and_skips_unknown_ones() {
        let zip = unhex(SAMPLE);
        assert_eq!(read_entry(&zip, "stored.txt").unwrap().unwrap(), b"stored!");
        assert!(read_entry(&zip, "nope.xml").unwrap().is_none());
        assert_eq!(
            entry_names(&zip).unwrap(),
            vec!["word/document.xml".to_string(), "stored.txt".to_string()]
        );
    }
}
