//! Read-only access to the character saves FiveM keeps for client resources.
//!
//! `SetResourceKvp` stores values in a LevelDB database under
//! `%APPDATA%\CitizenFX\kvs` (and `kvs_cl2` for a second client). Keys are
//! `res:<resource>:<key>` and values are MessagePack. vMenu saves multiplayer
//! characters there (`mp_ped_*`, `vmenu_mpchar_*`) and saved peds (`ped_*`,
//! `vmenu_ped_*`), so Cortex reads those entries without asking the player to
//! export anything.
//!
//! The database belongs to FiveM. Nothing here writes, locks, compacts or
//! repairs it: files are opened for reading only and parsed directly, which is
//! why this is a small LevelDB reader rather than a LevelDB binding (opening a
//! database with LevelDB takes its lock and may rewrite it). While FiveM runs it
//! holds the write-ahead log exclusively; entries still only in that log are
//! then missing and the result says so.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

const STORES: [&str; 2] = ["kvs", "kvs_cl2"];
const KEY_PREFIXES: [&str; 4] = ["mp_ped_", "vmenu_mpchar_", "vmenu_ped_", "ped_"];
const MAX_TABLE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LOG_BYTES: u64 = 256 * 1024 * 1024;
const MAX_BLOCK_BYTES: usize = 64 * 1024 * 1024;
const MAX_VALUE_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECORDS: usize = 2000;
const LOG_BLOCK_SIZE: usize = 32 * 1024;
const TABLE_MAGIC: u64 = 0xdb47_7524_8b80_fb57;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KvsRecord {
    /// `kvs` or `kvs_cl2`.
    pub store: String,
    pub resource: String,
    pub key: String,
    /// The stored string, normally JSON. Parsed by the renderer.
    pub value: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvsScan {
    pub root: String,
    pub records: Vec<KvsRecord>,
    /// Stores that exist under the root.
    pub stores: Vec<String>,
    /// Files that could not be read, with the reason. Usually the log FiveM
    /// holds open while it runs.
    pub unreadable: Vec<String>,
    pub truncated: bool,
}

/// Scans every KVS store under `citizenfx` (the `CitizenFX` roaming folder).
pub fn scan(citizenfx: &Path) -> KvsScan {
    let mut result = KvsScan {
        root: citizenfx.display().to_string(),
        ..KvsScan::default()
    };
    for store in STORES {
        let dir = citizenfx.join(store);
        if !dir.join("CURRENT").is_file() {
            continue;
        }
        result.stores.push(store.to_string());
        let entries = read_database(&dir, &mut result.unreadable);
        let mut keys: Vec<_> = entries.into_iter().collect();
        keys.sort_by(|a, b| a.0.cmp(&b.0));
        for (key, (_, value)) in keys {
            let Some(value) = value else { continue };
            let Some(record) = to_record(store, &key, &value) else {
                continue;
            };
            if result.records.len() >= MAX_RECORDS {
                result.truncated = true;
                break;
            }
            result.records.push(record);
        }
    }
    result
}

fn to_record(store: &str, key: &[u8], value: &[u8]) -> Option<KvsRecord> {
    let key = std::str::from_utf8(key).ok()?;
    let rest = key.strip_prefix("res:")?;
    let (resource, name) = rest.split_once(':')?;
    if resource.is_empty() || !KEY_PREFIXES.iter().any(|prefix| name.starts_with(prefix)) {
        return None;
    }
    let text = msgpack_str(value)?;
    if text.len() > MAX_VALUE_BYTES || !text.trim_start().starts_with('{') {
        return None;
    }
    Some(KvsRecord {
        store: store.to_string(),
        resource: resource.to_string(),
        key: name.to_string(),
        value: text.to_string(),
    })
}

/// A MessagePack string (fixstr, str8, str16 or str32). Other value types are
/// not character data.
fn msgpack_str(bytes: &[u8]) -> Option<&str> {
    let (&tag, rest) = bytes.split_first()?;
    let (len, body) = match tag {
        0xa0..=0xbf => ((tag & 0x1f) as usize, rest),
        0xd9 => (*rest.first()? as usize, rest.get(1..)?),
        0xda => (
            u16::from_be_bytes(rest.get(..2)?.try_into().ok()?) as usize,
            rest.get(2..)?,
        ),
        0xdb => (
            u32::from_be_bytes(rest.get(..4)?.try_into().ok()?) as usize,
            rest.get(4..)?,
        ),
        _ => return None,
    };
    std::str::from_utf8(body.get(..len)?).ok()
}

type Entries = HashMap<Vec<u8>, (u64, Option<Vec<u8>>)>;

/// Latest value (or deletion) per user key, merged across tables and logs by
/// sequence number.
fn read_database(dir: &Path, unreadable: &mut Vec<String>) -> Entries {
    let mut entries = Entries::new();
    let manifest = read_manifest(dir);
    let mut files: Vec<(u64, PathBuf, bool)> = Vec::new();
    if let Ok(listing) = fs::read_dir(dir) {
        for item in listing.flatten() {
            let path = item.path();
            let name = item.file_name().to_string_lossy().to_ascii_lowercase();
            let Some((stem, ext)) = name.rsplit_once('.') else {
                continue;
            };
            let Ok(number) = stem.parse::<u64>() else {
                continue;
            };
            match ext {
                "ldb" | "sst" => {
                    // A table the manifest no longer lists is obsolete and may
                    // hold values whose deletion was compacted away.
                    if manifest.as_ref().is_none_or(|m| m.live.contains(&number)) {
                        files.push((number, path, true));
                    }
                }
                "log" if manifest.as_ref().is_none_or(|m| number >= m.min_log) => {
                    files.push((number, path, false));
                }
                _ => {}
            }
        }
    }
    files.sort_by_key(|(number, _, _)| *number);
    for (_, path, is_table) in files {
        let outcome = if is_table {
            read_limited(&path, MAX_TABLE_BYTES).and_then(|bytes| read_table(&bytes, &mut entries))
        } else {
            read_limited(&path, MAX_LOG_BYTES).map(|bytes| read_log(&bytes, &mut entries))
        };
        if let Err(error) = outcome {
            unreadable.push(format!("{}: {error}", path.display()));
        }
    }
    entries
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > limit {
        return Err(format!("{size} bytes is over the {limit} byte limit"));
    }
    fs::read(path).map_err(|e| e.to_string())
}

/// Whether a user key is `res:<resource>:<character key>`. Checked before a
/// value is kept, so the rest of the store is never held in memory.
fn is_character_key(key: &[u8]) -> bool {
    let Some(rest) = key.strip_prefix(b"res:") else {
        return false;
    };
    let Some(colon) = rest.iter().position(|byte| *byte == b':') else {
        return false;
    };
    let name = &rest[colon + 1..];
    colon > 0
        && KEY_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix.as_bytes()))
}

fn put(entries: &mut Entries, key: &[u8], sequence: u64, value: Option<&[u8]>) {
    if !is_character_key(key) {
        return;
    }
    let newer = entries
        .get(key)
        .is_none_or(|(current, _)| sequence >= *current);
    if newer {
        entries.insert(key.to_vec(), (sequence, value.map(<[u8]>::to_vec)));
    }
}

struct Manifest {
    live: HashSet<u64>,
    min_log: u64,
}

fn read_manifest(dir: &Path) -> Option<Manifest> {
    let current = fs::read_to_string(dir.join("CURRENT")).ok()?;
    let name = current.trim();
    if !name.starts_with("MANIFEST-") || name.contains(['/', '\\']) {
        return None;
    }
    let bytes = read_limited(&dir.join(name), MAX_LOG_BYTES).ok()?;
    let mut live = HashSet::new();
    let mut log_number = 0u64;
    let mut prev_log = 0u64;
    for record in log_records(&bytes) {
        let mut cursor = Cursor::new(&record);
        while !cursor.done() {
            match cursor.varint()? {
                1 => {
                    cursor.slice()?;
                }
                2 => log_number = cursor.varint()?,
                3 | 4 => {
                    cursor.varint()?;
                }
                5 => {
                    cursor.varint()?;
                    cursor.slice()?;
                }
                6 => {
                    cursor.varint()?;
                    live.remove(&cursor.varint()?);
                }
                7 => {
                    cursor.varint()?;
                    live.insert(cursor.varint()?);
                    cursor.varint()?;
                    cursor.slice()?;
                    cursor.slice()?;
                }
                9 => prev_log = cursor.varint()?,
                _ => return None,
            }
        }
    }
    let min_log = if prev_log != 0 {
        prev_log.min(log_number)
    } else {
        log_number
    };
    Some(Manifest { live, min_log })
}

/// Physical records of a LevelDB log reassembled into logical records.
/// A damaged fragment drops the record it belongs to, as LevelDB's own
/// recovery does.
fn log_records(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut records = Vec::new();
    let mut pending: Option<Vec<u8>> = None;
    let mut block = 0;
    while block < bytes.len() {
        let end = (block + LOG_BLOCK_SIZE).min(bytes.len());
        let mut at = block;
        while at + 7 <= end {
            let length = u16::from_le_bytes([bytes[at + 4], bytes[at + 5]]) as usize;
            let kind = bytes[at + 6];
            let start = at + 7;
            if kind == 0 && length == 0 {
                break;
            }
            let Some(data) = bytes
                .get(start..start + length)
                .filter(|_| start + length <= end)
            else {
                pending = None;
                break;
            };
            match kind {
                1 => {
                    records.push(data.to_vec());
                    pending = None;
                }
                2 => pending = Some(data.to_vec()),
                3 => {
                    if let Some(buffer) = pending.as_mut() {
                        buffer.extend_from_slice(data);
                    }
                }
                4 => {
                    if let Some(mut buffer) = pending.take() {
                        buffer.extend_from_slice(data);
                        records.push(buffer);
                    }
                }
                _ => pending = None,
            }
            at = start + length;
        }
        block = end;
    }
    records
}

fn read_log(bytes: &[u8], entries: &mut Entries) {
    for record in log_records(bytes) {
        // WriteBatch: sequence u64, count u32, then tagged puts and deletes.
        if record.len() < 12 {
            continue;
        }
        let mut sequence = u64::from_le_bytes(record[..8].try_into().unwrap());
        let mut cursor = Cursor::new(&record[12..]);
        while !cursor.done() {
            let Some(tag) = cursor.byte() else { break };
            let Some(key) = cursor.slice() else { break };
            match tag {
                1 => {
                    let Some(value) = cursor.slice() else { break };
                    put(entries, key, sequence, Some(value));
                }
                0 => put(entries, key, sequence, None),
                _ => break,
            }
            sequence += 1;
        }
    }
}

fn read_table(bytes: &[u8], entries: &mut Entries) -> Result<(), String> {
    if bytes.len() < 48 {
        return Err("table is shorter than its footer".into());
    }
    let footer = &bytes[bytes.len() - 48..];
    if u64::from_le_bytes(footer[40..].try_into().unwrap()) != TABLE_MAGIC {
        return Err("not a LevelDB table".into());
    }
    let mut cursor = Cursor::new(footer);
    let bad = || "damaged table footer".to_string();
    cursor.varint().ok_or_else(bad)?;
    cursor.varint().ok_or_else(bad)?;
    let index_offset = cursor.varint().ok_or_else(bad)?;
    let index_size = cursor.varint().ok_or_else(bad)?;
    let index = read_block(bytes, index_offset, index_size)?;
    for (_, handle) in block_entries(&index)? {
        let mut cursor = Cursor::new(&handle);
        let offset = cursor.varint().ok_or("damaged block handle")?;
        let size = cursor.varint().ok_or("damaged block handle")?;
        let block = read_block(bytes, offset, size)?;
        for (internal_key, value) in block_entries(&block)? {
            if internal_key.len() < 8 {
                continue;
            }
            let (user_key, tag) = internal_key.split_at(internal_key.len() - 8);
            let tag = u64::from_le_bytes(tag.try_into().unwrap());
            let sequence = tag >> 8;
            match tag & 0xff {
                1 => put(entries, user_key, sequence, Some(&value)),
                0 => put(entries, user_key, sequence, None),
                _ => {}
            }
        }
    }
    Ok(())
}

fn read_block(bytes: &[u8], offset: u64, size: u64) -> Result<Vec<u8>, String> {
    let start = usize::try_from(offset).map_err(|_| "block offset out of range")?;
    let size = usize::try_from(size).map_err(|_| "block size out of range")?;
    let end = start.checked_add(size).ok_or("block size out of range")?;
    let data = bytes
        .get(start..end)
        .ok_or("block runs past the end of the table")?;
    let compression = *bytes.get(end).ok_or("block trailer missing")?;
    match compression {
        0 => Ok(data.to_vec()),
        1 => snappy_decompress(data),
        other => Err(format!("unsupported block compression {other}")),
    }
}

type BlockEntries = Vec<(Vec<u8>, Vec<u8>)>;

fn block_entries(block: &[u8]) -> Result<BlockEntries, String> {
    if block.len() < 4 {
        return Err("block too short".into());
    }
    let restarts = u32::from_le_bytes(block[block.len() - 4..].try_into().unwrap()) as usize;
    let restart_bytes = restarts
        .checked_mul(4)
        .and_then(|n| n.checked_add(4))
        .ok_or("bad restart count")?;
    if restart_bytes > block.len() {
        return Err("bad restart count".into());
    }
    let data = &block[..block.len() - restart_bytes];
    let mut cursor = Cursor::new(data);
    let mut key: Vec<u8> = Vec::new();
    let mut entries = Vec::new();
    while !cursor.done() {
        let shared = cursor.varint().ok_or("damaged block entry")? as usize;
        let unshared = cursor.varint().ok_or("damaged block entry")? as usize;
        let value_len = cursor.varint().ok_or("damaged block entry")? as usize;
        if shared > key.len() {
            return Err("damaged block entry".into());
        }
        key.truncate(shared);
        key.extend_from_slice(cursor.take(unshared).ok_or("damaged block entry")?);
        let value = cursor.take(value_len).ok_or("damaged block entry")?;
        entries.push((key.clone(), value.to_vec()));
    }
    Ok(entries)
}

/// Raw Snappy, the only compression LevelDB uses.
fn snappy_decompress(input: &[u8]) -> Result<Vec<u8>, String> {
    let bad = || "damaged snappy block".to_string();
    let mut cursor = Cursor::new(input);
    let length = usize::try_from(cursor.varint().ok_or_else(bad)?).map_err(|_| bad())?;
    if length > MAX_BLOCK_BYTES {
        return Err("snappy block too large".into());
    }
    let mut out: Vec<u8> = Vec::with_capacity(length);
    while !cursor.done() {
        let tag = cursor.byte().ok_or_else(bad)?;
        let (copy_len, offset) = match tag & 3 {
            0 => {
                let mut len = (tag >> 2) as usize;
                if len >= 60 {
                    let width = len - 59;
                    let raw = cursor.take(width).ok_or_else(bad)?;
                    len = raw
                        .iter()
                        .rev()
                        .fold(0usize, |acc, b| (acc << 8) | *b as usize);
                }
                let literal = cursor.take(len + 1).ok_or_else(bad)?;
                out.extend_from_slice(literal);
                if out.len() > length {
                    return Err(bad());
                }
                continue;
            }
            1 => {
                let low = cursor.byte().ok_or_else(bad)? as usize;
                (
                    ((tag >> 2) & 7) as usize + 4,
                    (((tag >> 5) as usize) << 8) | low,
                )
            }
            2 => {
                let raw = cursor.take(2).ok_or_else(bad)?;
                (
                    (tag >> 2) as usize + 1,
                    u16::from_le_bytes([raw[0], raw[1]]) as usize,
                )
            }
            _ => {
                let raw = cursor.take(4).ok_or_else(bad)?;
                (
                    (tag >> 2) as usize + 1,
                    u32::from_le_bytes(raw.try_into().unwrap()) as usize,
                )
            }
        };
        if offset == 0 || offset > out.len() || out.len() + copy_len > length {
            return Err(bad());
        }
        let start = out.len() - offset;
        for i in 0..copy_len {
            out.push(out[start + i]);
        }
    }
    if out.len() != length {
        return Err(bad());
    }
    Ok(out)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }

    fn done(&self) -> bool {
        self.at >= self.bytes.len()
    }

    fn byte(&mut self) -> Option<u8> {
        let value = *self.bytes.get(self.at)?;
        self.at += 1;
        Some(value)
    }

    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(len)?;
        let slice = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(slice)
    }

    fn varint(&mut self) -> Option<u64> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = self.byte()?;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }

    fn slice(&mut self) -> Option<&'a [u8]> {
        let len = usize::try_from(self.varint()?).ok()?;
        self.take(len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varint(out: &mut Vec<u8>, mut value: u64) {
        while value >= 0x80 {
            out.push((value as u8) | 0x80);
            value >>= 7;
        }
        out.push(value as u8);
    }

    fn msgpack(text: &str) -> Vec<u8> {
        let mut out = vec![0xda];
        out.extend_from_slice(&(text.len() as u16).to_be_bytes());
        out.extend_from_slice(text.as_bytes());
        out
    }

    fn block(entries: &[(Vec<u8>, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut previous: Vec<u8> = Vec::new();
        for (key, value) in entries {
            let shared = previous.iter().zip(key).take_while(|(a, b)| a == b).count();
            varint(&mut out, shared as u64);
            varint(&mut out, (key.len() - shared) as u64);
            varint(&mut out, value.len() as u64);
            out.extend_from_slice(&key[shared..]);
            out.extend_from_slice(value);
            previous = key.clone();
        }
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out
    }

    fn internal(key: &str, sequence: u64, kind: u64) -> Vec<u8> {
        let mut out = key.as_bytes().to_vec();
        out.extend_from_slice(&((sequence << 8) | kind).to_le_bytes());
        out
    }

    /// One data block, uncompressed, and its index.
    fn table(entries: &[(Vec<u8>, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        let data = block(entries);
        out.extend_from_slice(&data);
        out.extend_from_slice(&[0, 0, 0, 0, 0]);
        let mut handle = Vec::new();
        varint(&mut handle, 0);
        varint(&mut handle, data.len() as u64);
        let index_offset = out.len();
        let index = block(&[(entries.last().unwrap().0.clone(), handle)]);
        out.extend_from_slice(&index);
        out.extend_from_slice(&[0, 0, 0, 0, 0]);
        let mut footer = Vec::new();
        varint(&mut footer, 0);
        varint(&mut footer, 0);
        varint(&mut footer, index_offset as u64);
        varint(&mut footer, index.len() as u64);
        footer.resize(40, 0);
        footer.extend_from_slice(&TABLE_MAGIC.to_le_bytes());
        out.extend_from_slice(&footer);
        out
    }

    fn log(batches: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        for batch in batches {
            out.extend_from_slice(&[0, 0, 0, 0]);
            out.extend_from_slice(&(batch.len() as u16).to_le_bytes());
            out.push(1);
            out.extend_from_slice(batch);
        }
        out
    }

    fn batch(sequence: u64, ops: &[(&str, Option<Vec<u8>>)]) -> Vec<u8> {
        let mut out = sequence.to_le_bytes().to_vec();
        out.extend_from_slice(&(ops.len() as u32).to_le_bytes());
        for (key, value) in ops {
            out.push(u8::from(value.is_some()));
            varint(&mut out, key.len() as u64);
            out.extend_from_slice(key.as_bytes());
            if let Some(value) = value {
                varint(&mut out, value.len() as u64);
                out.extend_from_slice(value);
            }
        }
        out
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cortex-kvs-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("kvs")).unwrap();
        dir
    }

    #[test]
    fn reads_latest_character_values_from_tables_and_logs() {
        let root = temp_dir("merge");
        let store = root.join("kvs");
        let entries = vec![
            (
                internal("res:vMenu:mp_ped_Alice", 5, 1),
                msgpack(r#"{"SaveName":"mp_ped_Alice"}"#),
            ),
            (
                internal("res:vMenu:mp_ped_Bob", 6, 1),
                msgpack(r#"{"SaveName":"mp_ped_Bob"}"#),
            ),
            (
                internal("res:vMenu:settings_x", 7, 1),
                msgpack(r#"{"a":1}"#),
            ),
            (internal("res:other:director", 8, 1), msgpack("{}")),
        ];
        fs::write(store.join("000005.ldb"), table(&entries)).unwrap();
        fs::write(
            store.join("000007.log"),
            log(&[batch(
                20,
                &[
                    (
                        "res:vMenu:mp_ped_Alice",
                        Some(msgpack(r#"{"SaveName":"mp_ped_Alice","Version":2}"#)),
                    ),
                    ("res:vMenu:mp_ped_Bob", None),
                ],
            )]),
        )
        .unwrap();
        fs::write(store.join("CURRENT"), "MANIFEST-000001\n").unwrap();

        let scan = scan(&root);
        assert_eq!(scan.stores, vec!["kvs".to_string()]);
        assert!(scan.unreadable.is_empty(), "{:?}", scan.unreadable);
        assert_eq!(scan.records.len(), 1);
        assert_eq!(scan.records[0].resource, "vMenu");
        assert_eq!(scan.records[0].key, "mp_ped_Alice");
        assert!(scan.records[0].value.contains("\"Version\":2"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_excludes_obsolete_tables() {
        let root = temp_dir("manifest");
        let store = root.join("kvs");
        fs::write(
            store.join("000003.ldb"),
            table(&[(internal("res:vMenu:mp_ped_Gone", 1, 1), msgpack("{}"))]),
        )
        .unwrap();
        fs::write(
            store.join("000004.ldb"),
            table(&[(internal("res:vMenu:mp_ped_Kept", 2, 1), msgpack("{}"))]),
        )
        .unwrap();
        let mut edit = Vec::new();
        varint(&mut edit, 2);
        varint(&mut edit, 9);
        varint(&mut edit, 7);
        varint(&mut edit, 0);
        varint(&mut edit, 4);
        varint(&mut edit, 100);
        varint(&mut edit, 1);
        edit.push(b'a');
        varint(&mut edit, 1);
        edit.push(b'z');
        fs::write(store.join("MANIFEST-000002"), log(&[edit])).unwrap();
        fs::write(store.join("CURRENT"), "MANIFEST-000002\n").unwrap();

        let scan = scan(&root);
        let keys: Vec<_> = scan
            .records
            .iter()
            .map(|record| record.key.as_str())
            .collect();
        assert_eq!(keys, vec!["mp_ped_Kept"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_damaged_tables_and_non_string_values() {
        let mut entries = Entries::new();
        assert!(read_table(&[0u8; 20], &mut entries).is_err());
        let mut fake = vec![0u8; 48];
        fake[40..].copy_from_slice(&TABLE_MAGIC.to_le_bytes());
        fake[2] = 0xff;
        assert!(read_table(&fake, &mut entries).is_err());
        assert!(msgpack_str(&[0xcd, 0x01, 0x02]).is_none());
        assert!(msgpack_str(&[0xda, 0x00, 0x10, b'{']).is_none());
        assert_eq!(msgpack_str(&[0xa2, b'{', b'}']), Some("{}"));
    }

    #[test]
    fn snappy_round_trips_literals_and_copies() {
        // "abcabcabcabc": literal "abc" then a 9-byte copy at offset 3.
        let compressed = [12u8, 0x08, b'a', b'b', b'c', ((9 - 1) << 2) | 2, 3, 0];
        assert_eq!(snappy_decompress(&compressed).unwrap(), b"abcabcabcabc");
        assert!(snappy_decompress(&[4u8, 0x04, b'a']).is_err());
        assert!(snappy_decompress(&[3u8, ((3 - 1) << 2) | 2, 9, 0]).is_err());
    }

    /// Reads the real FiveM store on this machine:
    /// `CORTEX_KVS_ROOT=%APPDATA%\CitizenFX cargo test fivem_kvs -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reads_local_store() {
        let Ok(root) = std::env::var("CORTEX_KVS_ROOT") else {
            return;
        };
        let scan = scan(Path::new(&root));
        for record in &scan.records {
            println!(
                "{} {} {} ({} bytes)",
                record.store,
                record.resource,
                record.key,
                record.value.len()
            );
        }
        println!("unreadable: {:?}", scan.unreadable);
    }
}
