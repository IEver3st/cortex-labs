//! Paint.NET (`PDN3`) decoder behind the native `decode_pdn` fallback.
//!
//! A `.pdn` file is an XML header, a .NET BinaryFormatter (NRBF) document that
//! describes the layers, and then each layer's pixels as "deferred" chunks
//! after the document. This decoder reads the layer list from the document
//! instead of guessing from compressed data, then flattens the visible layers
//! bottom to top with their opacity and blend mode. Anything it cannot
//! reproduce (a blend mode Paint.NET doesn't have, an older or unexpected
//! layout, damaged or truncated data) is an error, never approximate output.

use std::{collections::HashMap, io::Read, path::Path, rc::Rc};

use flate2::read::GzDecoder;

const MAX_PDN_FILE_BYTES: u64 = 128 * 1024 * 1024; // 128 MB
const MAX_PDN_DIMENSION: u32 = 16_384;
const MAX_PDN_OUTPUT_BYTES: usize = 384 * 1024 * 1024; // 384 MB RGBA
const MAX_PDN_INFLATED_CHUNK_BYTES: usize = 64 * 1024 * 1024; // 64 MB/chunk
const MAX_PDN_TOTAL_INFLATED_BYTES: usize = 768 * 1024 * 1024; // 768 MB total
const MAX_HEADER_BYTES: usize = 1024 * 1024;
const MAX_NRBF_DEPTH: usize = 64;
const MAX_NRBF_MEMBERS: usize = 4096;
// Caps members read across all records, so tiny records that reuse a large
// class cannot make the reader build unbounded maps.
const MAX_NRBF_TOTAL_MEMBERS: usize = 1 << 20;

/// A flattened image in straight-alpha RGBA.
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Reads and flattens a `.pdn` file. Returns `u32 LE width`, `u32 LE height`,
/// then the RGBA pixels.
pub fn decode_file(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Failed to stat PDN file: {e}"))?;
    if meta.len() > MAX_PDN_FILE_BYTES {
        return Err(format!(
            "PDN file exceeds safety limit ({} bytes > {MAX_PDN_FILE_BYTES} bytes).",
            meta.len()
        ));
    }
    let data = std::fs::read(path).map_err(|e| format!("Failed to read PDN file: {e}"))?;
    let image = decode(&data)?;
    let mut payload = Vec::with_capacity(8 + image.rgba.len());
    payload.extend_from_slice(&image.width.to_le_bytes());
    payload.extend_from_slice(&image.height.to_le_bytes());
    payload.extend_from_slice(&image.rgba);
    Ok(payload)
}

struct Header {
    width: u32,
    height: u32,
    layers: Option<usize>,
    body_start: usize,
}

fn xml_attribute(tag: &str, name: &str) -> Option<String> {
    let needle = format!(" {name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let end = tag[start..].find('"')? + start;
    Some(tag[start..end].to_string())
}

fn parse_header(data: &[u8]) -> Result<Header, String> {
    if data.len() < 7 || &data[0..4] != b"PDN3" {
        return Err("Not a Paint.NET file (missing PDN3 signature).".to_string());
    }
    let length = data[4] as usize | (data[5] as usize) << 8 | (data[6] as usize) << 16;
    let xml_end = 7 + length;
    if length == 0 || length > MAX_HEADER_BYTES || xml_end + 2 > data.len() {
        return Err("The .pdn header is damaged or the file is truncated.".to_string());
    }
    let xml = String::from_utf8_lossy(&data[7..xml_end]);
    let tag = xml
        .find("<pdnImage")
        .and_then(|start| xml[start..].find('>').map(|end| &xml[start..start + end]))
        .ok_or("The .pdn header has no image description.")?;
    let dimension = |name: &str| {
        xml_attribute(tag, name)
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| format!("The .pdn header has no valid image {name}."))
    };
    let width = dimension("width")?;
    let height = dimension("height")?;
    let layers = xml_attribute(tag, "layers").and_then(|value| value.parse::<usize>().ok());
    match &data[xml_end..xml_end + 2] {
        [0x00, 0x01] => {}
        [0x1f, 0x8b] => {
            return Err(
                "This .pdn uses an older compressed layout the fallback decoder does not read. \
Open and save it in a current Paint.NET, or save a PNG copy."
                    .to_string(),
            )
        }
        _ => return Err("The .pdn document layout is not recognised.".to_string()),
    }
    Ok(Header {
        width,
        height,
        layers,
        body_start: xml_end + 2,
    })
}

/// A member value from the NRBF document. Only what the layer list needs is kept.
#[derive(Clone, Debug, PartialEq)]
enum Value {
    Bool(bool),
    Int(i64),
    Str(String),
    /// A reference to an object or string by id.
    Ref(i32),
    /// An object or array written inline, by id.
    Object(i32),
    Null,
    Other,
}

enum MemberKind {
    Primitive(u8),
    Record,
}

struct ClassMeta {
    name: Rc<str>,
    members: Vec<(String, MemberKind)>,
}

struct Object {
    id: i32,
    class: Rc<str>,
    members: HashMap<String, Value>,
}

enum Record {
    Value(Value),
    Library,
    Header,
    End,
    Nulls(usize),
}

/// A reader for the subset of [MS-NRBF] that BinaryFormatter writes for
/// object graphs: class, string, array, reference and null records.
struct Nrbf<'a> {
    data: &'a [u8],
    pos: usize,
    classes: HashMap<i32, Rc<ClassMeta>>,
    objects: Vec<Object>,
    strings: HashMap<i32, String>,
    /// Non-null elements of object and string arrays, by index.
    arrays: HashMap<i32, Vec<(usize, Value)>>,
    members_read: usize,
}

impl<'a> Nrbf<'a> {
    fn new(data: &'a [u8], pos: usize) -> Self {
        Self {
            data,
            pos,
            classes: HashMap::new(),
            objects: Vec::new(),
            strings: HashMap::new(),
            arrays: HashMap::new(),
            members_read: 0,
        }
    }

    fn error(&self, message: &str) -> String {
        format!(
            "The .pdn layer document could not be read ({message} at byte {}).",
            self.pos
        )
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(count)
            .filter(|end| *end <= self.data.len())
            .ok_or_else(|| self.error("unexpected end of file"))?;
        let bytes = &self.data[self.pos..end];
        self.pos = end;
        Ok(bytes)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn count(&mut self) -> Result<usize, String> {
        let value = self.i32()?;
        usize::try_from(value).map_err(|_| self.error("negative length"))
    }

    fn string(&mut self) -> Result<String, String> {
        let mut length = 0usize;
        for shift in (0..35).step_by(7) {
            let byte = self.u8()?;
            length |= ((byte & 0x7f) as usize) << shift;
            if byte & 0x80 == 0 {
                let bytes = self.take(length)?;
                return Ok(String::from_utf8_lossy(bytes).into_owned());
            }
        }
        Err(self.error("bad string length"))
    }

    fn primitive_size(kind: u8) -> Option<usize> {
        match kind {
            1 | 2 | 10 => Some(1),
            7 | 14 => Some(2),
            8 | 11 | 15 => Some(4),
            6 | 9 | 12 | 13 | 16 => Some(8),
            17 => Some(0),
            _ => None,
        }
    }

    fn primitive(&mut self, kind: u8) -> Result<Value, String> {
        Ok(match kind {
            1 => Value::Bool(self.u8()? != 0),
            2 => Value::Int(self.u8()? as i64),
            10 => Value::Int(self.u8()? as i8 as i64),
            7 => Value::Int(i16::from_le_bytes(self.take(2)?.try_into().unwrap()) as i64),
            14 => Value::Int(u16::from_le_bytes(self.take(2)?.try_into().unwrap()) as i64),
            8 => Value::Int(self.i32()? as i64),
            15 => Value::Int(u32::from_le_bytes(self.take(4)?.try_into().unwrap()) as i64),
            9 => Value::Int(i64::from_le_bytes(self.take(8)?.try_into().unwrap())),
            3 => {
                // A UTF-8 encoded char: the lead byte gives its length.
                let lead = self.u8()?;
                let extra = match lead {
                    0x00..=0x7f => 0,
                    0xc0..=0xdf => 1,
                    0xe0..=0xef => 2,
                    0xf0..=0xf7 => 3,
                    _ => return Err(self.error("bad char value")),
                };
                self.take(extra)?;
                Value::Other
            }
            5 | 18 => Value::Str(self.string()?),
            17 => Value::Null,
            _ => match Self::primitive_size(kind) {
                Some(size) => {
                    self.take(size)?;
                    Value::Other
                }
                None => return Err(self.error(&format!("unknown primitive type {kind}"))),
            },
        })
    }

    fn class_info(&mut self) -> Result<(i32, Rc<str>, Vec<String>), String> {
        let id = self.i32()?;
        let name: Rc<str> = self.string()?.into();
        let count = self.count()?;
        if count > MAX_NRBF_MEMBERS {
            return Err(self.error("too many class members"));
        }
        let names = (0..count)
            .map(|_| self.string())
            .collect::<Result<Vec<_>, _>>()?;
        Ok((id, name, names))
    }

    /// Reads a BinaryTypeEnumeration's additional info; returns the primitive
    /// type when values of this type are written inline.
    fn additional_type_info(&mut self, binary_type: u8) -> Result<Option<u8>, String> {
        match binary_type {
            0 => Ok(Some(self.u8()?)),
            7 => {
                self.u8()?;
                Ok(None)
            }
            3 => {
                self.string()?;
                Ok(None)
            }
            4 => {
                self.string()?;
                self.i32()?;
                Ok(None)
            }
            1 | 2 | 5 | 6 => Ok(None),
            other => Err(self.error(&format!("unknown member type {other}"))),
        }
    }

    fn typed_members(&mut self, names: Vec<String>) -> Result<Vec<(String, MemberKind)>, String> {
        let binary_types = self.take(names.len())?.to_vec();
        let mut members = Vec::with_capacity(names.len());
        for (name, binary_type) in names.into_iter().zip(binary_types) {
            let kind = match self.additional_type_info(binary_type)? {
                Some(primitive) => MemberKind::Primitive(primitive),
                None => MemberKind::Record,
            };
            members.push((name, kind));
        }
        Ok(members)
    }

    fn define_class(
        &mut self,
        id: i32,
        name: Rc<str>,
        members: Vec<(String, MemberKind)>,
    ) -> Rc<ClassMeta> {
        let meta = Rc::new(ClassMeta { name, members });
        self.classes.insert(id, Rc::clone(&meta));
        meta
    }

    fn members(&mut self, id: i32, meta: Rc<ClassMeta>, depth: usize) -> Result<Record, String> {
        self.members_read += meta.members.len();
        if self.members_read > MAX_NRBF_TOTAL_MEMBERS {
            return Err(
                "The .pdn document has more records than the fallback decoder reads.".to_string(),
            );
        }
        let mut members = HashMap::with_capacity(meta.members.len());
        for (name, kind) in &meta.members {
            let value = match kind {
                MemberKind::Primitive(primitive) => self.primitive(*primitive)?,
                MemberKind::Record => self.value(depth + 1)?,
            };
            members.insert(name.clone(), value);
        }
        self.objects.push(Object {
            id,
            class: Rc::clone(&meta.name),
            members,
        });
        Ok(Record::Value(Value::Object(id)))
    }

    fn value(&mut self, depth: usize) -> Result<Value, String> {
        loop {
            match self.record(depth)? {
                Record::Value(value) => return Ok(value),
                Record::Library => continue,
                _ => return Err(self.error("unexpected record in a member")),
            }
        }
    }

    fn elements(&mut self, id: i32, count: usize, depth: usize) -> Result<(), String> {
        let mut read = 0usize;
        let mut values = Vec::new();
        while read < count {
            match self.record(depth + 1)? {
                Record::Value(Value::Null) => read += 1,
                Record::Value(value) => {
                    values.push((read, value));
                    read += 1;
                }
                Record::Library => {}
                Record::Nulls(nulls) if nulls > 0 => read = read.saturating_add(nulls),
                _ => return Err(self.error("unexpected record in an array")),
            }
        }
        if read > count {
            return Err(self.error("array overrun"));
        }
        self.arrays.insert(id, values);
        Ok(())
    }

    fn primitive_elements(&mut self, kind: u8, count: usize) -> Result<(), String> {
        match Self::primitive_size(kind) {
            Some(size) => {
                let bytes = count
                    .checked_mul(size)
                    .ok_or_else(|| self.error("array too large"))?;
                self.take(bytes)?;
            }
            None => {
                for _ in 0..count {
                    self.primitive(kind)?;
                }
            }
        }
        Ok(())
    }

    fn record(&mut self, depth: usize) -> Result<Record, String> {
        if depth > MAX_NRBF_DEPTH {
            return Err(self.error("objects nest too deeply"));
        }
        match self.u8()? {
            0 => {
                self.take(16)?;
                Ok(Record::Header)
            }
            1 => {
                let id = self.i32()?;
                let metadata = self.i32()?;
                let meta = self
                    .classes
                    .get(&metadata)
                    .cloned()
                    .ok_or_else(|| self.error("reference to an unknown class"))?;
                self.members(id, meta, depth)
            }
            kind @ (2 | 3) => {
                let (id, name, names) = self.class_info()?;
                if kind == 3 {
                    self.i32()?;
                }
                let members = names.into_iter().map(|n| (n, MemberKind::Record)).collect();
                let meta = self.define_class(id, name, members);
                self.members(id, meta, depth)
            }
            kind @ (4 | 5) => {
                let (id, name, names) = self.class_info()?;
                let members = self.typed_members(names)?;
                if kind == 5 {
                    self.i32()?;
                }
                let meta = self.define_class(id, name, members);
                self.members(id, meta, depth)
            }
            6 => {
                let id = self.i32()?;
                let value = self.string()?;
                self.strings.insert(id, value.clone());
                Ok(Record::Value(Value::Str(value)))
            }
            7 => {
                let id = self.i32()?;
                let array_type = self.u8()?;
                let rank = self.count()?;
                if rank == 0 || rank > 32 {
                    return Err(self.error("bad array rank"));
                }
                let mut count = 1usize;
                for _ in 0..rank {
                    count = count
                        .checked_mul(self.count()?)
                        .ok_or_else(|| self.error("array too large"))?;
                }
                if (3..=5).contains(&array_type) {
                    self.take(4 * rank)?;
                }
                let binary_type = self.u8()?;
                match self.additional_type_info(binary_type)? {
                    Some(primitive) => self.primitive_elements(primitive, count)?,
                    None => self.elements(id, count, depth)?,
                }
                Ok(Record::Value(Value::Object(id)))
            }
            8 => {
                let kind = self.u8()?;
                Ok(Record::Value(self.primitive(kind)?))
            }
            9 => Ok(Record::Value(Value::Ref(self.i32()?))),
            10 => Ok(Record::Value(Value::Null)),
            11 => Ok(Record::End),
            12 => {
                self.i32()?;
                self.string()?;
                Ok(Record::Library)
            }
            13 => Ok(Record::Nulls(self.u8()? as usize)),
            14 => Ok(Record::Nulls(self.count()?)),
            15 => {
                let id = self.i32()?;
                let count = self.count()?;
                let kind = self.u8()?;
                self.primitive_elements(kind, count)?;
                Ok(Record::Value(Value::Object(id)))
            }
            16 | 17 => {
                let id = self.i32()?;
                let count = self.count()?;
                self.elements(id, count, depth)?;
                Ok(Record::Value(Value::Object(id)))
            }
            other => Err(self.error(&format!("unsupported record type {other}"))),
        }
    }

    /// Reads records up to MessageEnd; the deferred pixel data starts after it.
    fn read_document(&mut self) -> Result<(), String> {
        loop {
            if let Record::End = self.record(0)? {
                return Ok(());
            }
        }
    }
}

/// The class name after its namespace and declaring type.
fn short_name(class: &str) -> &str {
    class.rsplit(['.', '+']).next().unwrap_or(class)
}

fn member<'o>(object: &'o Object, name: &str) -> Option<&'o Value> {
    object.members.get(name)
}

fn int_member(object: &Object, name: &str) -> Option<i64> {
    match member(object, name)? {
        Value::Int(value) => Some(*value),
        _ => None,
    }
}

fn bool_member(object: &Object, name: &str) -> Option<bool> {
    match member(object, name)? {
        Value::Bool(value) => Some(*value),
        _ => None,
    }
}

fn reference(value: Option<&Value>) -> Option<i32> {
    match value? {
        Value::Ref(id) | Value::Object(id) => Some(*id),
        _ => None,
    }
}

/// Paint.NET's layer blend modes, in `LayerBlendMode` enum order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Blend {
    Normal,
    Multiply,
    Additive,
    ColorBurn,
    ColorDodge,
    Reflect,
    Glow,
    Overlay,
    Difference,
    Negation,
    Lighten,
    Darken,
    Screen,
    Xor,
}

const BLENDS: [(Blend, &str); 14] = [
    (Blend::Normal, "Normal"),
    (Blend::Multiply, "Multiply"),
    (Blend::Additive, "Additive"),
    (Blend::ColorBurn, "ColorBurn"),
    (Blend::ColorDodge, "ColorDodge"),
    (Blend::Reflect, "Reflect"),
    (Blend::Glow, "Glow"),
    (Blend::Overlay, "Overlay"),
    (Blend::Difference, "Difference"),
    (Blend::Negation, "Negation"),
    (Blend::Lighten, "Lighten"),
    (Blend::Darken, "Darken"),
    (Blend::Screen, "Screen"),
    (Blend::Xor, "Xor"),
];

impl Blend {
    /// From a `UserBlendOps+<Name>BlendOp` class name.
    fn from_op(op: &str) -> Option<Self> {
        let name = op.strip_suffix("BlendOp")?;
        BLENDS.iter().find(|(_, n)| *n == name).map(|(b, _)| *b)
    }

    /// From a `LayerBlendMode` enum value.
    fn from_value(value: i64) -> Option<Self> {
        usize::try_from(value)
            .ok()
            .and_then(|index| BLENDS.get(index))
            .map(|(b, _)| *b)
    }

    /// Paint.NET's per-channel blend of a bottom colour `d` and a layer
    /// colour `s` (0-255). Integer division truncates, as Paint.NET's does;
    /// measured equal to Paint.NET 5 for every input.
    fn channel(self, d: i32, s: i32) -> i32 {
        match self {
            Blend::Normal => s,
            Blend::Multiply => mul_div_255(d, s),
            Blend::Additive => (d + s).min(255),
            Blend::ColorBurn if s == 0 => 0,
            Blend::ColorBurn => (255 - (255 - d) * 255 / s).max(0),
            Blend::ColorDodge if s == 255 => 255,
            Blend::ColorDodge => (d * 255 / (255 - s)).min(255),
            Blend::Reflect if s == 255 => 255,
            Blend::Reflect => (d * d / (255 - s)).min(255),
            Blend::Glow if d == 255 => 255,
            Blend::Glow => (s * s / (255 - d)).min(255),
            Blend::Overlay if d < 128 => mul_div_255(2 * d, s),
            Blend::Overlay => 255 - mul_div_255(2 * (255 - d), 255 - s),
            Blend::Difference => (s - d).abs(),
            Blend::Negation => 255 - (255 - d - s).abs(),
            Blend::Lighten => d.max(s),
            Blend::Darken => d.min(s),
            Blend::Screen => d + s - mul_div_255(d, s),
            Blend::Xor => d ^ s,
        }
    }
}

struct Layer {
    name: String,
    visible: bool,
    opacity: u8,
    blend: Blend,
}

/// Pixel blocks in the order their data follows the document.
struct Block {
    length: usize,
    layer: Option<usize>,
}

fn read_layers(doc: &Nrbf, header: &Header) -> Result<(Vec<Layer>, Vec<Block>), String> {
    let objects: HashMap<i32, &Object> = doc.objects.iter().map(|o| (o.id, o)).collect();
    let resolve = |value: Option<&Value>| reference(value).and_then(|id| objects.get(&id).copied());
    let unreadable = || "The .pdn layer list could not be read.".to_string();
    let field = |object: &Object, suffix: &str| {
        object
            .members
            .iter()
            .find(|(name, _)| name.ends_with(suffix))
            .map(|(_, value)| value.clone())
    };

    // Document.layers is a LayerList (an ArrayList); index 0 is the bottom layer.
    let document = doc
        .objects
        .iter()
        .find(|object| short_name(&object.class) == "Document")
        .ok_or_else(unreadable)?;
    let list = resolve(member(document, "layers")).ok_or_else(unreadable)?;
    let count = match field(list, "_size") {
        Some(Value::Int(size)) => usize::try_from(size).ok(),
        _ => None,
    }
    .ok_or_else(unreadable)?;
    let items = reference(field(list, "_items").as_ref())
        .and_then(|id| doc.arrays.get(&id))
        .ok_or_else(unreadable)?;
    if count == 0 || count > items.len() || header.layers.is_some_and(|expected| expected != count)
    {
        return Err(format!(
            "The .pdn layer list does not match its header ({count} layers{}).",
            header
                .layers
                .map(|expected| format!(", {expected} in the header"))
                .unwrap_or_default()
        ));
    }

    // Deferred pixel data follows the document in the order the blocks were written.
    let memory_blocks: Vec<&Object> = doc
        .objects
        .iter()
        .filter(|object| short_name(&object.class) == "MemoryBlock")
        .collect();
    let expected_length = header.width as usize * header.height as usize * 4;
    let mut blocks = Vec::with_capacity(memory_blocks.len());
    for block in &memory_blocks {
        if bool_member(block, "deferred") != Some(true)
            || bool_member(block, "hasParent") == Some(true)
        {
            return Err(
                "This .pdn stores layer pixels inline (an older layout) that the fallback decoder does not read."
                    .to_string(),
            );
        }
        let length = int_member(block, "length64")
            .or_else(|| int_member(block, "length"))
            .and_then(|value| usize::try_from(value).ok())
            .ok_or("A .pdn pixel block has no valid length.")?;
        if length > MAX_PDN_OUTPUT_BYTES {
            return Err(
                "A .pdn pixel block is larger than any image the decoder accepts.".to_string(),
            );
        }
        blocks.push(Block {
            length,
            layer: None,
        });
    }

    let mut layers = Vec::with_capacity(count);
    for index in 0..count {
        let layer = items
            .iter()
            .find(|(at, _)| *at == index)
            .and_then(|(_, value)| resolve(Some(value)))
            .ok_or_else(unreadable)?;
        if short_name(&layer.class) != "BitmapLayer" {
            return Err(format!(
                "Layer {} is not a bitmap layer, which the fallback decoder cannot read.",
                index + 1
            ));
        }
        let (mut props, mut bitmap, mut surface) = (None, None, None);
        for value in layer.members.values() {
            if let Some(object) = resolve(Some(value)) {
                match short_name(&object.class) {
                    "LayerProperties" => props = Some(object),
                    "BitmapLayerProperties" => bitmap = Some(object),
                    "Surface" => surface = Some(object),
                    _ => {}
                }
            }
        }
        let (Some(props), Some(surface)) = (props, surface) else {
            return Err(unreadable());
        };

        let name = match member(props, "name") {
            Some(Value::Str(name)) => name.clone(),
            Some(Value::Ref(id)) => doc.strings.get(id).cloned().unwrap_or_default(),
            _ => String::new(),
        };
        let name = if name.trim().is_empty() {
            format!("Layer {}", index + 1)
        } else {
            name
        };
        let visible = bool_member(props, "visible")
            .ok_or_else(|| format!("Layer \u{201c}{name}\u{201d} has no visibility setting."))?;
        let opacity = int_member(props, "opacity")
            .and_then(|value| u8::try_from(value).ok())
            .ok_or_else(|| format!("Layer \u{201c}{name}\u{201d} has no valid opacity."))?;

        let width = int_member(surface, "width");
        let height = int_member(surface, "height");
        let stride = int_member(surface, "stride");
        if width != Some(header.width as i64)
            || height != Some(header.height as i64)
            || stride.is_some_and(|stride| stride != header.width as i64 * 4)
        {
            return Err(format!(
                "Layer \u{201c}{name}\u{201d} does not match the {}x{} canvas.",
                header.width, header.height
            ));
        }
        let scan0 = reference(member(surface, "scan0"))
            .ok_or_else(|| format!("Layer \u{201c}{name}\u{201d} has no pixel data."))?;
        let block = memory_blocks
            .iter()
            .position(|block| block.id == scan0)
            .ok_or_else(|| format!("Layer \u{201c}{name}\u{201d} has no pixel data."))?;
        if blocks[block].length != expected_length || blocks[block].layer.is_some() {
            return Err(format!(
                "Layer \u{201c}{name}\u{201d} pixel data does not match the canvas size."
            ));
        }
        blocks[block].layer = Some(index);

        let mut blend = Blend::Normal;
        if visible {
            // Paint.NET takes the blend from the layer's BlendOp class when it
            // has one and from the LayerBlendMode enum otherwise (BitmapLayer's
            // deserialization callback).
            let op = match bitmap.and_then(|bitmap| member(bitmap, "blendOp")) {
                None | Some(Value::Null) => None,
                Some(value) => Some(
                    resolve(Some(value))
                        .map(|op| short_name(&op.class))
                        .ok_or_else(|| {
                            format!("Layer \u{201c}{name}\u{201d} has an unreadable blend mode.")
                        })?,
                ),
            };
            let (found, detail) = match op {
                Some(op) => (Blend::from_op(op), op.to_string()),
                None => match resolve(member(props, "blendMode"))
                    .and_then(|mode| int_member(mode, "value__"))
                {
                    Some(value) => (Blend::from_value(value), format!("value {value}")),
                    None => (Some(Blend::Normal), String::new()),
                },
            };
            blend = found.ok_or_else(|| {
                format!(
                    "Layer \u{201c}{name}\u{201d} uses an unrecognised blend mode ({detail}), which the fallback decoder cannot reproduce. \
Set the layer's blend mode to Normal in Paint.NET, or save a flattened PNG copy."
                )
            })?;
        }
        layers.push(Layer {
            name,
            visible,
            opacity,
            blend,
        });
    }

    // Layers are flattened as their data arrives, so the data must come
    // bottom layer first. BinaryFormatter writes it in layer-list order.
    let mut previous = None;
    for block in &blocks {
        if let Some(layer) = block.layer {
            if previous.is_some_and(|previous| previous > layer) {
                return Err(
                    "The .pdn pixel data is not in layer order; the fallback decoder cannot flatten it."
                        .to_string(),
                );
            }
            previous = Some(layer);
        }
    }
    Ok((layers, blocks))
}

fn read_u32_be(data: &[u8], pos: &mut usize, what: &str) -> Result<u32, String> {
    let bytes = data
        .get(*pos..*pos + 4)
        .ok_or_else(|| format!("The .pdn file is truncated in {what}."))?;
    *pos += 4;
    Ok(u32::from_be_bytes(bytes.try_into().unwrap()))
}

fn inflate_exact(compressed: &[u8], out: &mut [u8]) -> std::io::Result<()> {
    let mut decoder = GzDecoder::new(compressed);
    decoder.read_exact(out)?;
    let mut extra = [0u8; 1];
    // Reading to the end also checks the gzip CRC.
    match decoder.read(&mut extra)? {
        0 => Ok(()),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "chunk is larger than expected",
        )),
    }
}

/// `a * b / 255` rounded, for bytes, the way Paint.NET scales colours and alpha.
fn mul_div_255(a: i32, b: i32) -> i32 {
    let r = a * b + 128;
    ((r >> 8) + r) >> 8
}

/// Composites a straight-alpha BGRA layer over a straight-alpha RGBA canvas
/// the way Paint.NET flattens: the layer's alpha is scaled by `opacity`, then
/// where layer and canvas overlap the mode's blended colour shows, and where
/// only one covers the pixel its own colour shows, in proportion to alpha.
/// All integer arithmetic: byte-identical to the JS decoder's
/// `compositePdnLayer` and to Paint.NET for every mode, Normal included.
fn blend_layer(canvas: &mut [u8], layer: &[u8], opacity: u8, blend: Blend) {
    let normal = blend == Blend::Normal;
    let mut table = Vec::new();
    if !normal {
        table = vec![0u8; 256 * 256];
        for d in 0..256 {
            for s in 0..256 {
                table[(d << 8 | s) as usize] = blend.channel(d, s) as u8;
            }
        }
    }
    let mut alpha = [0u8; 256];
    for (a, scaled) in alpha.iter_mut().enumerate() {
        *scaled = mul_div_255(a as i32, opacity as i32) as u8;
    }
    for (dst, src) in canvas.chunks_exact_mut(4).zip(layer.chunks_exact(4)) {
        let sa = alpha[src[3] as usize] as i32;
        if sa == 0 {
            continue;
        }
        let da = dst[3] as i32;
        // Exact shortcuts of the general case below: over a transparent pixel
        // every mode shows the layer, and an opaque Normal layer replaces it.
        if da == 0 || (normal && sa == 255) {
            dst[0] = src[2];
            dst[1] = src[1];
            dst[2] = src[0];
            dst[3] = sa as u8;
            continue;
        }
        let bottom_only = mul_div_255(da, 255 - sa);
        let total = bottom_only + sa;
        let both = mul_div_255(da, sa);
        let layer_only = sa - both;
        for c in 0..3 {
            let d = dst[c] as i32;
            let s = src[2 - c] as i32; // BGRA -> RGBA
            dst[c] = if normal {
                ((d * bottom_only + s * sa) / total) as u8
            } else {
                let blended = table[(d << 8 | s) as usize] as i32;
                ((d * bottom_only + s * layer_only + blended * both) / total) as u8
            };
        }
        dst[3] = total as u8;
    }
}

/// Decodes and flattens a `.pdn` file's bytes.
pub fn decode(data: &[u8]) -> Result<Image, String> {
    let header = parse_header(data)?;
    if header.width == 0
        || header.height == 0
        || header.width > MAX_PDN_DIMENSION
        || header.height > MAX_PDN_DIMENSION
    {
        return Err(format!(
            "Invalid PDN dimensions: {}x{}",
            header.width, header.height
        ));
    }
    let canvas_bytes = header.width as usize * header.height as usize * 4;
    if canvas_bytes > MAX_PDN_OUTPUT_BYTES {
        return Err(format!(
            "PDN image dimensions exceed safety output limit ({canvas_bytes} bytes > {MAX_PDN_OUTPUT_BYTES} bytes)."
        ));
    }

    let mut doc = Nrbf::new(data, header.body_start);
    doc.read_document()?;
    let (layers, blocks) = read_layers(&doc, &header)?;

    let mut canvas = vec![0u8; canvas_bytes];
    let mut pixels = vec![0u8; canvas_bytes];
    let mut inflated_total = 0usize;
    let mut pos = doc.pos;
    for block in &blocks {
        let layer = block.layer.map(|index| &layers[index]);
        let what = layer
            .map(|layer| format!("layer \u{201c}{}\u{201d}", layer.name))
            .unwrap_or_else(|| "a pixel block".to_string());
        let wanted = layer.is_some_and(|layer| layer.visible && layer.opacity > 0);

        let format = *data
            .get(pos)
            .ok_or_else(|| format!("The .pdn file is truncated in {what}."))?;
        pos += 1;
        if format > 1 {
            return Err(format!("The pixel data of {what} uses an unknown format."));
        }
        let chunk_size = read_u32_be(data, &mut pos, &what)? as usize;
        if chunk_size == 0 || chunk_size > MAX_PDN_INFLATED_CHUNK_BYTES {
            return Err(format!(
                "The pixel data of {what} has an invalid chunk size."
            ));
        }
        let chunks = block.length.div_ceil(chunk_size);
        // Each chunk has an 8-byte header, so more chunks than that cannot fit.
        if chunks > data.len().saturating_sub(pos) / 8 {
            return Err(format!("The .pdn file is truncated in {what}."));
        }
        let mut seen = vec![false; chunks];
        for _ in 0..chunks {
            let number = read_u32_be(data, &mut pos, &what)? as usize;
            let size = read_u32_be(data, &mut pos, &what)? as usize;
            if number >= chunks || seen[number] {
                return Err(format!(
                    "The pixel data of {what} is damaged (bad chunk number)."
                ));
            }
            seen[number] = true;
            let payload = pos
                .checked_add(size)
                .and_then(|end| data.get(pos..end))
                .ok_or_else(|| format!("The .pdn file is truncated in {what}."))?;
            pos += size;
            if !wanted {
                continue;
            }
            let start = number * chunk_size;
            let end = (start + chunk_size).min(block.length);
            inflated_total += end - start;
            if inflated_total > MAX_PDN_TOTAL_INFLATED_BYTES {
                return Err(format!(
                    "PDN decode exceeded total inflate safety limit ({MAX_PDN_TOTAL_INFLATED_BYTES} bytes)."
                ));
            }
            let target = &mut pixels[start..end];
            if format == 0 {
                inflate_exact(payload, target).map_err(|e| {
                    format!(
                        "The pixel data of {what} is damaged and could not be decompressed: {e}"
                    )
                })?;
            } else if payload.len() == target.len() {
                target.copy_from_slice(payload);
            } else {
                return Err(format!("The pixel data of {what} has the wrong size."));
            }
        }
        if let Some(layer) = layer.filter(|_| wanted) {
            blend_layer(&mut canvas, &pixels, layer.opacity, layer.blend);
        }
    }

    Ok(Image {
        width: header.width,
        height: header.height,
        rgba: canvas,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    /// Minimal NRBF writer for the records Paint.NET documents use.
    #[derive(Default)]
    struct Writer(Vec<u8>);

    enum Kind<'a> {
        Bool,
        Byte,
        Int32,
        Int64,
        Str,
        Class(&'a str),
        ObjectArray,
    }

    impl Writer {
        fn u8(&mut self, value: u8) -> &mut Self {
            self.0.push(value);
            self
        }
        fn i32(&mut self, value: i32) -> &mut Self {
            self.0.extend_from_slice(&value.to_le_bytes());
            self
        }
        fn i64(&mut self, value: i64) -> &mut Self {
            self.0.extend_from_slice(&value.to_le_bytes());
            self
        }
        fn string(&mut self, value: &str) -> &mut Self {
            let mut length = value.len();
            loop {
                let byte = (length & 0x7f) as u8;
                length >>= 7;
                if length == 0 {
                    self.u8(byte);
                    break;
                }
                self.u8(byte | 0x80);
            }
            self.0.extend_from_slice(value.as_bytes());
            self
        }
        /// ClassWithMembersAndTypes; the caller writes the member values next.
        fn class(&mut self, id: i32, name: &str, members: &[(&str, Kind)]) -> &mut Self {
            self.u8(5).i32(id).string(name).i32(members.len() as i32);
            for (member, _) in members {
                self.string(member);
            }
            for (_, kind) in members {
                self.u8(match kind {
                    Kind::Bool | Kind::Byte | Kind::Int32 | Kind::Int64 => 0,
                    Kind::Str => 1,
                    Kind::Class(_) => 4,
                    Kind::ObjectArray => 5,
                });
            }
            for (_, kind) in members {
                match kind {
                    Kind::Bool => {
                        self.u8(1);
                    }
                    Kind::Byte => {
                        self.u8(2);
                    }
                    Kind::Int32 => {
                        self.u8(8);
                    }
                    Kind::Int64 => {
                        self.u8(9);
                    }
                    Kind::Str | Kind::ObjectArray => {}
                    Kind::Class(class) => {
                        self.string(class).i32(2);
                    }
                }
            }
            self.i32(2)
        }
        /// ClassWithId: another instance of an already described class.
        fn instance(&mut self, id: i32, metadata: i32) -> &mut Self {
            self.u8(1).i32(id).i32(metadata)
        }
        fn text(&mut self, id: i32, value: &str) -> &mut Self {
            self.u8(6).i32(id).string(value)
        }
        fn reference(&mut self, id: i32) -> &mut Self {
            self.u8(9).i32(id)
        }
    }

    struct TestLayer {
        name: &'static str,
        visible: bool,
        opacity: u8,
        /// The `<Name>BlendOp` class; empty writes a null blendOp.
        blend: &'static str,
        /// The LayerBlendMode enum value; defaults to the blend's own.
        blend_enum: Option<i32>,
        /// BGRA pixels.
        pixels: Vec<u8>,
    }

    fn blend_value(name: &str) -> i32 {
        BLENDS.iter().position(|(_, n)| *n == name).unwrap_or(0) as i32
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// A PDN3 file shaped like Paint.NET 5 output: header, the NRBF document
    /// (Document -> LayerList -> BitmapLayer -> properties, surface, memory
    /// block), then deferred gzip chunks written last chunk first, as Paint.NET's
    /// threaded writer may.
    fn build_pdn(width: u32, height: u32, layers: &[TestLayer], chunk_size: usize) -> Vec<u8> {
        let xml = format!(
            "<pdnImage width=\"{width}\" height=\"{height}\" layers=\"{}\" savedWithVersion=\"5.102\"><custom /></pdnImage>",
            layers.len()
        );
        let mut doc = Writer::default();
        doc.u8(0).i32(1).i32(-1).i32(1).i32(0);
        doc.u8(12).i32(2).string("PaintDotNet.Core");
        doc.class(
            1,
            "PaintDotNet.Document",
            &[
                ("width", Kind::Int32),
                ("height", Kind::Int32),
                ("layers", Kind::Class("PaintDotNet.LayerList")),
            ],
        )
        .i32(width as i32)
        .i32(height as i32)
        .reference(3);
        doc.class(
            3,
            "PaintDotNet.LayerList",
            &[
                ("ArrayList+_items", Kind::ObjectArray),
                ("ArrayList+_size", Kind::Int32),
            ],
        )
        .reference(7)
        .i32(layers.len() as i32);
        // ArraySingleObject with spare capacity, like ArrayList's backing array.
        doc.u8(16).i32(7).i32(layers.len() as i32 + 2);
        let base = |index: usize| 20 + 10 * index as i32;
        for index in 0..layers.len() {
            doc.reference(base(index));
        }
        doc.u8(13).u8(2);

        for index in 0..layers.len() {
            let l = base(index);
            if index == 0 {
                doc.class(
                    l,
                    "PaintDotNet.BitmapLayer",
                    &[
                        (
                            "properties",
                            Kind::Class("PaintDotNet.BitmapLayer+BitmapLayerProperties"),
                        ),
                        ("surface", Kind::Class("PaintDotNet.Surface")),
                        (
                            "Layer+properties",
                            Kind::Class("PaintDotNet.Layer+LayerProperties"),
                        ),
                    ],
                );
            } else {
                doc.instance(l, 20);
            }
            doc.reference(l + 3).reference(l + 2).reference(l + 1);
        }
        let length = (width * height * 4) as i64;
        for (index, layer) in layers.iter().enumerate() {
            let l = base(index);
            if index == 0 {
                doc.class(
                    l + 1,
                    "PaintDotNet.Layer+LayerProperties",
                    &[
                        ("name", Kind::Str),
                        ("visible", Kind::Bool),
                        ("isBackground", Kind::Bool),
                        ("opacity", Kind::Byte),
                        ("blendMode", Kind::Class("PaintDotNet.LayerBlendMode")),
                    ],
                );
            } else {
                doc.instance(l + 1, 21);
            }
            doc.text(l + 6, layer.name)
                .u8(layer.visible as u8)
                .u8((index == 0) as u8)
                .u8(layer.opacity);
            // The enum is a value type, written inline with a negative id.
            if index == 0 {
                doc.class(
                    -(l + 7),
                    "PaintDotNet.LayerBlendMode",
                    &[("value__", Kind::Int32)],
                );
            } else {
                doc.instance(-(l + 7), -27);
            }
            doc.i32(layer.blend_enum.unwrap_or_else(|| blend_value(layer.blend)));
            if index == 0 {
                doc.class(
                    l + 2,
                    "PaintDotNet.Surface",
                    &[
                        ("width", Kind::Int32),
                        ("height", Kind::Int32),
                        ("stride", Kind::Int32),
                        ("scan0", Kind::Class("PaintDotNet.MemoryBlock")),
                    ],
                );
            } else {
                doc.instance(l + 2, 22);
            }
            doc.i32(width as i32)
                .i32(height as i32)
                .i32(width as i32 * 4)
                .reference(l + 4);
            if index == 0 {
                doc.class(
                    l + 3,
                    "PaintDotNet.BitmapLayer+BitmapLayerProperties",
                    &[("blendOp", Kind::Class("PaintDotNet.UserBlendOp"))],
                );
            } else {
                doc.instance(l + 3, 23);
            }
            if layer.blend.is_empty() {
                doc.u8(10); // ObjectNull
            } else {
                doc.reference(l + 5);
            }
        }
        for (index, layer) in layers.iter().enumerate() {
            let l = base(index);
            if !layer.blend.is_empty() {
                doc.class(
                    l + 5,
                    &format!("PaintDotNet.UserBlendOps+{}BlendOp", layer.blend),
                    &[],
                );
            }
            if index == 0 {
                doc.class(
                    l + 4,
                    "PaintDotNet.MemoryBlock",
                    &[
                        ("length64", Kind::Int64),
                        ("hasParent", Kind::Bool),
                        ("deferred", Kind::Bool),
                    ],
                );
            } else {
                doc.instance(l + 4, 24);
            }
            doc.i64(length).u8(0).u8(1);
        }
        doc.u8(11);

        let mut file = b"PDN3".to_vec();
        let size = xml.len() as u32;
        file.extend_from_slice(&size.to_le_bytes()[..3]);
        file.extend_from_slice(xml.as_bytes());
        file.extend_from_slice(&[0x00, 0x01]);
        file.extend_from_slice(&doc.0);
        for layer in layers {
            file.push(0);
            file.extend_from_slice(&(chunk_size as u32).to_be_bytes());
            let chunks: Vec<&[u8]> = layer.pixels.chunks(chunk_size).collect();
            for (number, chunk) in chunks.iter().enumerate().rev() {
                let compressed = gzip(chunk);
                file.extend_from_slice(&(number as u32).to_be_bytes());
                file.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
                file.extend_from_slice(&compressed);
            }
        }
        file
    }

    fn layer(
        name: &'static str,
        visible: bool,
        opacity: u8,
        blend: &'static str,
        bgra: [u8; 4],
    ) -> TestLayer {
        TestLayer {
            name,
            visible,
            opacity,
            blend,
            blend_enum: None,
            pixels: bgra.repeat(4),
        }
    }

    #[test]
    fn flattens_visible_layers_with_opacity() {
        let file = build_pdn(
            2,
            2,
            &[
                layer("Background", true, 255, "Normal", [0, 0, 255, 255]),
                layer("Tint", true, 128, "Normal", [255, 0, 0, 255]),
            ],
            5,
        );
        let image = decode(&file).unwrap();
        assert_eq!((image.width, image.height), (2, 2));
        // 128/255 blue over opaque red.
        assert_eq!(&image.rgba[..4], &[127, 0, 128, 255]);
        assert_eq!(image.rgba.len(), 16);
    }

    #[test]
    fn hidden_layers_are_ignored_even_with_other_blend_modes() {
        let file = build_pdn(
            2,
            2,
            &[
                layer("Background", true, 255, "Normal", [10, 20, 30, 255]),
                layer("Shadows", false, 255, "Multiply", [0, 0, 0, 255]),
            ],
            16,
        );
        let image = decode(&file).unwrap();
        assert_eq!(&image.rgba[..4], &[30, 20, 10, 255]);
    }

    /// Expectations measured with Paint.NET's own Document.Flatten (see
    /// docs/fixes/p9-pdn-blend.md); shared with the JS decoder's tests.
    const BLEND_TABLE: &str =
        include_str!("../../src/lib/__fixtures__/pdn-blend-expectations.json");

    fn bytes_of(value: &serde_json::Value) -> Vec<u8> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect()
    }

    #[test]
    fn blend_modes_match_paint_net() {
        let table: serde_json::Value = serde_json::from_str(BLEND_TABLE).unwrap();
        let pairs = table["pairs"].as_array().unwrap();
        let rgba_to_bgra = |rgba: Vec<u8>| vec![rgba[2], rgba[1], rgba[0], rgba[3]];
        let bottom: Vec<u8> = pairs
            .iter()
            .flat_map(|pair| rgba_to_bgra(bytes_of(&pair[0])))
            .collect();
        let top: Vec<u8> = pairs
            .iter()
            .flat_map(|pair| rgba_to_bgra(bytes_of(&pair[1])))
            .collect();
        let opacities = bytes_of(&table["opacities"]);
        let expected = table["expected"].as_object().unwrap();
        assert_eq!(expected.len(), BLENDS.len());
        for (_, name) in BLENDS {
            for (row, opacity) in opacities.iter().enumerate() {
                let file = build_pdn(
                    pairs.len() as u32,
                    1,
                    &[
                        TestLayer {
                            name: "Background",
                            visible: true,
                            opacity: 255,
                            blend: "Normal",
                            blend_enum: None,
                            pixels: bottom.clone(),
                        },
                        TestLayer {
                            name: "Top",
                            visible: true,
                            opacity: *opacity,
                            blend: name,
                            blend_enum: None,
                            pixels: top.clone(),
                        },
                    ],
                    16,
                );
                let image = decode(&file).unwrap();
                for (index, want) in expected[name][row].as_array().unwrap().iter().enumerate() {
                    let want = bytes_of(want);
                    let got = &image.rgba[index * 4..index * 4 + 4];
                    assert_eq!(got, &want[..], "{name} @{opacity} pair {index}");
                }
            }
        }
    }

    #[test]
    fn blend_mode_comes_from_the_blend_op_then_the_enum() {
        let base = layer("Background", true, 255, "Normal", [200, 100, 50, 255]);
        let top = |blend: &'static str, blend_enum: Option<i32>| TestLayer {
            name: "Shadows",
            visible: true,
            opacity: 255,
            blend,
            blend_enum,
            pixels: [128, 128, 128, 255].repeat(4),
        };
        let pixel = |layers: &[TestLayer]| {
            decode(&build_pdn(2, 2, layers, 16)).map(|image| image.rgba[..4].to_vec())
        };
        let base_again = || layer("Background", true, 255, "Normal", [200, 100, 50, 255]);
        // Multiply: 50*128/255, 100*128/255, 200*128/255 (RGBA).
        let multiplied = vec![25, 50, 100, 255];
        assert_eq!(pixel(&[base, top("Multiply", None)]).unwrap(), multiplied);
        // Paint.NET ignores the enum when there is a BlendOp.
        assert_eq!(
            pixel(&[base_again(), top("Multiply", Some(0))]).unwrap(),
            multiplied
        );
        // Without a BlendOp, the enum decides (1 is Multiply).
        assert_eq!(
            pixel(&[base_again(), top("", Some(1))]).unwrap(),
            multiplied
        );
        assert_eq!(
            pixel(&[base_again(), top("", None)]).unwrap(),
            vec![128, 128, 128, 255]
        );

        // Blends Paint.NET doesn't have are refused with the layer's name.
        let error = pixel(&[base_again(), top("Hologram", None)]).unwrap_err();
        assert!(
            error.contains("Shadows")
                && error.contains("HologramBlendOp")
                && error.contains("Normal"),
            "{error}"
        );
        let error = pixel(&[base_again(), top("", Some(42))]).unwrap_err();
        assert!(
            error.contains("Shadows") && error.contains("value 42"),
            "{error}"
        );
        // A hidden layer's blend doesn't matter.
        let mut hidden = top("Hologram", None);
        hidden.visible = false;
        assert_eq!(
            pixel(&[base_again(), hidden]).unwrap(),
            vec![50, 100, 200, 255]
        );
    }

    #[test]
    fn truncated_pixel_data_is_an_error() {
        let file = build_pdn(
            2,
            2,
            &[layer("Background", true, 255, "Normal", [1, 2, 3, 255])],
            16,
        );
        let error = decode(&file[..file.len() - 3]).err().unwrap();
        assert!(error.contains("truncated"), "{error}");
    }

    #[test]
    fn damaged_chunks_are_an_error() {
        let mut file = build_pdn(
            2,
            2,
            &[layer("Background", true, 255, "Normal", [1, 2, 3, 255])],
            16,
        );
        // Corrupt the gzip CRC in the trailer of the only chunk.
        let crc = file.len() - 8;
        file[crc] ^= 0xff;
        let error = decode(&file).err().unwrap();
        assert!(error.contains("damaged"), "{error}");
    }

    #[test]
    fn header_without_dimensions_or_signature_is_rejected() {
        assert!(decode(b"PNG\0\0\0\0").is_err());
        let mut file = build_pdn(
            2,
            2,
            &[layer("Background", true, 255, "Normal", [1, 2, 3, 255])],
            16,
        );
        let at = file.windows(9).position(|w| w == b"width=\"2\"").unwrap();
        file[at..at + 9].copy_from_slice(b"wodth=\"2\"");
        assert!(decode(&file).err().unwrap().contains("width"));
    }

    #[test]
    fn layer_count_must_match_the_header() {
        let mut file = build_pdn(
            2,
            2,
            &[layer("Background", true, 255, "Normal", [1, 2, 3, 255])],
            16,
        );
        let at = file.windows(10).position(|w| w == b"layers=\"1\"").unwrap();
        file[at + 8] = b'2';
        assert!(decode(&file)
            .err()
            .unwrap()
            .contains("does not match its header"));
    }

    /// Manual probe against a real Paint.NET file:
    /// `CORTEX_PDN_SAMPLE=path cargo test pdn::tests::decodes_a_real_file -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn decodes_a_real_file() {
        let path = std::env::var("CORTEX_PDN_SAMPLE").expect("set CORTEX_PDN_SAMPLE");
        let image = decode(&std::fs::read(path).unwrap()).unwrap();
        let opaque = image.rgba.chunks_exact(4).filter(|p| p[3] > 0).count();
        println!(
            "{}x{}, {opaque} non-transparent pixels",
            image.width, image.height
        );
        assert_eq!(image.rgba.len(), (image.width * image.height * 4) as usize);
    }

    /// Manual probe against files Paint.NET wrote, each `<name>.pdn` next to
    /// `<name>.rgba`, Paint.NET's own flatten (see docs/fixes/p9-pdn-blend.md):
    /// `CORTEX_PDN_BLEND_DIR=dir cargo test pdn::tests::matches_paint_net_flattens -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn matches_paint_net_flattens() {
        let dir = std::env::var("CORTEX_PDN_BLEND_DIR").expect("set CORTEX_PDN_BLEND_DIR");
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "pdn"))
            .collect();
        entries.sort();
        assert!(!entries.is_empty(), "no .pdn files");
        for path in entries {
            let data = std::fs::read(&path).unwrap();
            let image = decode(&data).unwrap();
            let expected = std::fs::read(path.with_extension("rgba")).unwrap();
            assert_eq!(image.rgba.len(), expected.len());
            let mut max = 0u8;
            for (got, want) in image.rgba.chunks_exact(4).zip(expected.chunks_exact(4)) {
                let mut diff = got[3].abs_diff(want[3]);
                if got[3] == 0 {
                    // Paint.NET may keep a colour under zero alpha. Both decoders
                    // leave zeros there, so they also match each other exactly.
                    assert_eq!(got, [0; 4], "{}", path.display());
                } else {
                    for c in 0..3 {
                        diff = diff.max(got[c].abs_diff(want[c]));
                    }
                }
                max = max.max(diff);
            }
            println!("{}: max difference {max}", path.display());
            assert_eq!(max, 0, "{} differs from Paint.NET", path.display());
        }
    }
}
