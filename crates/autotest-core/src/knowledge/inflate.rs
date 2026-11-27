//! Raw DEFLATE (RFC 1951) decompression.
//!
//! `.docx` and `.xlsx` are ZIP archives whose parts are almost always deflated,
//! and no compression crate is in the frozen dependency set, so the reader is
//! implemented here. Only what a document archive needs is supported: stored and
//! deflated members, no encryption, no ZIP64.

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    bit: u32,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            pos: 0,
            bit: 0,
        }
    }

    fn bit(&mut self) -> Result<u32, String> {
        if self.pos >= self.data.len() {
            return Err("deflate: 数据提前结束".to_string());
        }
        let value = (self.data[self.pos] >> self.bit) & 1;
        self.bit += 1;
        if self.bit == 8 {
            self.bit = 0;
            self.pos += 1;
        }
        Ok(u32::from(value))
    }

    fn bits(&mut self, count: u32) -> Result<u32, String> {
        let mut value = 0u32;
        for index in 0..count {
            value |= self.bit()? << index;
        }
        Ok(value)
    }

    fn align(&mut self) {
        if self.bit != 0 {
            self.bit = 0;
            self.pos += 1;
        }
    }

    fn u16_le(&mut self) -> Result<u16, String> {
        if self.pos + 2 > self.data.len() {
            return Err("deflate: 数据提前结束".to_string());
        }
        let value = u16::from_le_bytes([self.data[self.pos], self.data[self.pos + 1]]);
        self.pos += 2;
        Ok(value)
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        if self.pos + count > self.data.len() {
            return Err("deflate: 数据提前结束".to_string());
        }
        let slice = &self.data[self.pos..self.pos + count];
        self.pos += count;
        Ok(slice)
    }
}

/// Canonical Huffman table, decoded the way zlib's `puff` does: walk the bit
/// stream one bit at a time and compare against the code counts per length.
struct Huffman {
    counts: [u16; 16],
    symbols: Vec<u16>,
}

impl Huffman {
    fn new(lengths: &[u8]) -> Result<Self, String> {
        let mut counts = [0u16; 16];
        for &length in lengths {
            counts[length as usize] += 1;
        }
        counts[0] = 0;

        let mut left: i32 = 1;
        for length in 1..16 {
            left <<= 1;
            left -= i32::from(counts[length]);
            if left < 0 {
                return Err("deflate: 霍夫曼表非法".to_string());
            }
        }

        let mut offsets = [0u16; 16];
        for length in 1..15 {
            offsets[length + 1] = offsets[length] + counts[length];
        }
        let mut symbols = vec![0u16; lengths.len()];
        for (symbol, &length) in lengths.iter().enumerate() {
            if length != 0 {
                symbols[offsets[length as usize] as usize] = symbol as u16;
                offsets[length as usize] += 1;
            }
        }
        Ok(Self { counts, symbols })
    }

    fn decode(&self, reader: &mut BitReader<'_>) -> Result<u16, String> {
        let mut code: i32 = 0;
        let mut first: i32 = 0;
        let mut index: i32 = 0;
        for length in 1..16 {
            code |= reader.bit()? as i32;
            let count = i32::from(self.counts[length]);
            if code - first < count {
                let position = index + (code - first);
                return self
                    .symbols
                    .get(position as usize)
                    .copied()
                    .ok_or_else(|| "deflate: 霍夫曼码越界".to_string());
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        Err("deflate: 霍夫曼码非法".to_string())
    }
}

const LENGTH_BASE: [usize; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LENGTH_EXTRA: [u32; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_BASE: [usize; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA: [u32; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];
const CODE_LENGTH_ORDER: [usize; 19] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

fn fixed_tables() -> (Huffman, Huffman) {
    let mut literal_lengths = [0u8; 288];
    for (symbol, slot) in literal_lengths.iter_mut().enumerate() {
        *slot = match symbol {
            0..=143 => 8,
            144..=255 => 9,
            256..=279 => 7,
            _ => 8,
        };
    }
    let distance_lengths = [5u8; 32];
    (
        Huffman::new(&literal_lengths).expect("fixed literal table"),
        Huffman::new(&distance_lengths).expect("fixed distance table"),
    )
}

pub fn inflate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut reader = BitReader::new(data);
    let mut out: Vec<u8> = Vec::new();

    loop {
        let last = reader.bit()?;
        let block_type = reader.bits(2)?;
        let (literal, distance) = match block_type {
            0 => {
                reader.align();
                let length = reader.u16_le()? as usize;
                let complement = reader.u16_le()?;
                if (length as u16) != !complement {
                    return Err("deflate: 存储块长度校验失败".to_string());
                }
                let bytes = reader.take(length)?;
                out.extend_from_slice(bytes);
                if last == 1 {
                    break;
                }
                continue;
            }
            1 => fixed_tables(),
            2 => dynamic_tables(&mut reader)?,
            _ => return Err("deflate: 块类型非法".to_string()),
        };

        loop {
            let symbol = literal.decode(&mut reader)?;
            if symbol < 256 {
                out.push(symbol as u8);
                continue;
            }
            if symbol == 256 {
                break;
            }
            let index = usize::from(symbol) - 257;
            if index >= LENGTH_BASE.len() {
                return Err("deflate: 长度码非法".to_string());
            }
            let length = LENGTH_BASE[index] + reader.bits(LENGTH_EXTRA[index])? as usize;
            let distance_symbol = usize::from(distance.decode(&mut reader)?);
            if distance_symbol >= DISTANCE_BASE.len() {
                return Err("deflate: 距离码非法".to_string());
            }
            let back = DISTANCE_BASE[distance_symbol]
                + reader.bits(DISTANCE_EXTRA[distance_symbol])? as usize;
            if back > out.len() {
                return Err("deflate: 回溯距离超过已解压数据".to_string());
            }
            for _ in 0..length {
                let byte = out[out.len() - back];
                out.push(byte);
            }
        }

        if last == 1 {
            break;
        }
    }

    Ok(out)
}

fn dynamic_tables(reader: &mut BitReader<'_>) -> Result<(Huffman, Huffman), String> {
    let literal_count = reader.bits(5)? as usize + 257;
    let distance_count = reader.bits(5)? as usize + 1;
    let code_count = reader.bits(4)? as usize + 4;

    let mut code_lengths = [0u8; 19];
    for index in 0..code_count {
        code_lengths[CODE_LENGTH_ORDER[index]] = reader.bits(3)? as u8;
    }
    let code_table = Huffman::new(&code_lengths)?;

    let total = literal_count + distance_count;
    let mut lengths = vec![0u8; total];
    let mut index = 0usize;
    while index < total {
        let symbol = code_table.decode(reader)?;
        match symbol {
            0..=15 => {
                lengths[index] = symbol as u8;
                index += 1;
            }
            16 => {
                if index == 0 {
                    return Err("deflate: 重复码出现在首位".to_string());
                }
                let previous = lengths[index - 1];
                let repeat = 3 + reader.bits(2)? as usize;
                for _ in 0..repeat {
                    if index >= total {
                        return Err("deflate: 码长溢出".to_string());
                    }
                    lengths[index] = previous;
                    index += 1;
                }
            }
            17 => {
                let repeat = 3 + reader.bits(3)? as usize;
                index += repeat;
            }
            18 => {
                let repeat = 11 + reader.bits(7)? as usize;
                index += repeat;
            }
            _ => return Err("deflate: 码长码非法".to_string()),
        }
    }
    if index > total {
        return Err("deflate: 码长溢出".to_string());
    }

    let literal = Huffman::new(&lengths[..literal_count])?;
    let distance = Huffman::new(&lengths[literal_count..])?;
    Ok((literal, distance))
}

#[cfg(test)]
mod tests {
    use super::inflate;

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

    #[test]
    fn inflates_a_stream_produced_by_zlib() {
        // zlib.compressobj(6, zlib.DEFLATED, -15) over a heading plus six lines.
        let compressed = unhex(
            "5356783e65ebb38d0b9eaf5bf87c42dbf3cdbb9fef9eff724ec3b38d4d5c4f7ba73ed93b1928\
             fdb4affb657bfbcbd96d0a0675a60606060ab961eff7f400859e2dd8fe74e28a6773e62b18824\
             48b1f378cea42d50500",
        );
        let expected = "# 电池管理系统需求\n".to_string()
            + &"单体电压采集 0~5000 mV，采样周期 100 ms。\n".repeat(6);
        let out = inflate(&compressed).expect("inflate");
        assert_eq!(String::from_utf8(out).expect("utf8"), expected);
    }
}
