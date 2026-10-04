//! Experimental v1 immutable filesystem view, independent of transport/OS.
//! Content integrity is not authority, encryption, availability or finality.
//! See docs/FILESYSTEM-SNAPSHOT-V1.md for the exact wire and security boundary.

use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
};

pub mod builder;
#[cfg(all(feature = "fuse", unix, not(target_arch = "wasm32")))]
pub mod fuse;
#[cfg(all(unix, not(target_arch = "wasm32")))]
pub mod native;
pub mod revisions;
pub mod transfer;

pub const VERSION: u32 = 1;
pub const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 1024 * 1024;
pub const MAX_READ_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 4096;
pub const MAX_CHUNKS: usize = 4096;
pub const MAX_DEPTH: usize = 64;
pub const MAX_TREE_NODES: usize = 65536;
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Invalid(&'static str),
    Decode(String),
    UnsupportedVersion(u32),
    Integrity,
    NonCanonical,
    Limit,
    NotFound,
    NotDirectory,
    NotFile,
    Unavailable,
    Transport(String),
    /// Unclassified provider failure: must not trigger availability fallback.
    Provider(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}

/// BLAKE3 of exact stored bytes. Lowercase 64-character hex on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ContentId([u8; 32]);

impl ContentId {
    pub fn for_bytes(bytes: &[u8]) -> Self {
        Self(*blake3::hash(bytes).as_bytes())
    }
}
impl From<ContentId> for String {
    fn from(id: ContentId) -> Self {
        blake3::Hash::from(id.0).to_hex().to_string()
    }
}
impl TryFrom<String> for ContentId {
    type Error = Error;
    fn try_from(value: String) -> Result<Self, Error> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(Error::Invalid("content id"));
        }
        let mut bytes = [0; 32];
        for (i, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[2 * i..2 * i + 2], 16)
                .map_err(|_| Error::Invalid("content id"))?;
        }
        Ok(Self(bytes))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    File,
    Directory,
}

/// Logical inode allocated by the namespace writer, retained across revisions.
/// Unique within a tree; not derived from the content hash or an authority key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeRef {
    pub inode: u64,
    pub kind: NodeKind,
    pub manifest: ContentId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub name: String,
    pub node: NodeRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Directory {
    pub inode: u64,
    pub modified_ms: u64,
    /// Strict ascending UTF-8 byte order, no duplicate names.
    pub entries: Vec<Entry>,
}
impl Directory {
    /// Sort producer input; validation still rejects duplicate/unsafe names.
    pub fn new(inode: u64, modified_ms: u64, mut entries: Vec<Entry>) -> Result<Self, Error> {
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let result = Self {
            inode,
            modified_ms,
            entries,
        };
        Manifest::new(Node::Directory(result.clone())).validate()?;
        Ok(result)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Chunk {
    pub content: ContentId,
    pub size: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct File {
    pub inode: u64,
    pub modified_ms: u64,
    pub executable: bool,
    pub size: u64,
    /// Contiguous chunks in file order; empty files have no chunks.
    pub chunks: Vec<Chunk>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    /// Opaque namespace identity, NOT an authorization credential.
    pub namespace: ContentId,
    pub generation: u64,
    pub previous: Option<ContentId>,
    pub root: NodeRef,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "body",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Node {
    Directory(Directory),
    File(File),
    Snapshot(Snapshot),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub node: Node,
}

fn integer(value: u64) -> Result<(), Error> {
    if value > MAX_SAFE_INTEGER {
        Err(Error::Invalid("unsafe integer"))
    } else {
        Ok(())
    }
}
fn inode(value: u64) -> Result<(), Error> {
    integer(value)?;
    if value == 0 {
        Err(Error::Invalid("zero inode"))
    } else {
        Ok(())
    }
}
fn name(value: &str) -> Result<(), Error> {
    if value.is_empty()
        || value.len() > 255
        || value == "."
        || value == ".."
        || value
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(Error::Invalid("name"));
    }
    Ok(())
}
impl Manifest {
    pub fn new(node: Node) -> Self {
        Self {
            schema_version: VERSION,
            node,
        }
    }
    pub fn validate(&self) -> Result<(), Error> {
        if self.schema_version != VERSION {
            return Err(Error::UnsupportedVersion(self.schema_version));
        }
        match &self.node {
            Node::Directory(dir) => {
                inode(dir.inode)?;
                integer(dir.modified_ms)?;
                if dir.entries.len() > MAX_ENTRIES {
                    return Err(Error::Limit);
                }
                let mut previous: Option<&str> = None;
                for entry in &dir.entries {
                    name(&entry.name)?;
                    inode(entry.node.inode)?;
                    if previous.is_some_and(|p| p >= entry.name.as_str()) {
                        return Err(Error::Invalid("unsorted or duplicate entry"));
                    }
                    previous = Some(&entry.name);
                }
            }
            Node::File(file) => {
                inode(file.inode)?;
                integer(file.modified_ms)?;
                integer(file.size)?;
                if file.chunks.len() > MAX_CHUNKS {
                    return Err(Error::Limit);
                }
                let mut total = 0u64;
                for chunk in &file.chunks {
                    if chunk.size == 0 || chunk.size as usize > MAX_CHUNK_BYTES {
                        return Err(Error::Invalid("chunk size"));
                    }
                    total = total
                        .checked_add(u64::from(chunk.size))
                        .ok_or(Error::Limit)?;
                }
                if total != file.size {
                    return Err(Error::Invalid("file size"));
                }
            }
            Node::Snapshot(snapshot) => {
                integer(snapshot.generation)?;
                inode(snapshot.root.inode)?;
                if snapshot.root.kind != NodeKind::Directory {
                    return Err(Error::NotDirectory);
                }
                if (snapshot.generation == 0) != snapshot.previous.is_none() {
                    return Err(Error::Invalid("snapshot predecessor"));
                }
            }
        }
        Ok(())
    }
    /// v1 canonical form is compact serde JSON in declared field order.
    /// This is a schema-specific encoding, NOT a general JSON canonicalizer.
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|e| Error::Decode(e.to_string()))?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
    pub fn id(&self) -> Result<ContentId, Error> {
        Ok(ContentId::for_bytes(&self.encode()?))
    }
    /// Bound bytes before decoding; reject unsupported, noncanonical and
    /// unknown/duplicate-field documents even if they have a matching hash.
    pub fn decode(expected: ContentId, bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(Error::Limit);
        }
        if ContentId::for_bytes(bytes) != expected {
            return Err(Error::Integrity);
        }
        let result: Self =
            serde_json::from_slice(bytes).map_err(|e| Error::Decode(e.to_string()))?;
        if result.encode()? != bytes {
            return Err(Error::NonCanonical);
        }
        Ok(result)
    }
}

/// Adapter must enforce max_bytes while streaming, not after unbounded buffering.
/// Futures intentionally need not be Send: browser Worker adapters are supported.
/// Authentication, encrypted-object resolution, timeout and cancellation belong
/// to the adapter. The core rechecks length/hash and never trusts returned bytes.
#[allow(async_fn_in_trait)]
pub trait ObjectReader {
    async fn get(&self, id: ContentId, max_bytes: usize) -> Result<Vec<u8>, Error>;
}

/// Acknowledgement means the adapter has durably stored these exact bytes.
/// It does not imply namespace-head commit or mirror/chain finality.
#[allow(async_fn_in_trait)]
pub trait ObjectWriter {
    async fn put(&self, bytes: &[u8]) -> Result<ContentId, Error>;
}

/// Scan all retained roots with shared verification and global work budgets.
/// The caller must treat any error as a refusal to reclaim storage.
pub async fn reachable_ids_for_roots_bounded<R: ObjectReader>(
    reader: &R,
    roots: &[ContentId],
    max_objects: usize,
    max_bytes: u64,
    max_visits: usize,
    max_read_bytes: u64,
) -> Result<Vec<ContentId>, Error> {
    if roots.len() > 1024 || max_objects == 0 || max_visits == 0 {
        return Err(Error::Limit);
    }
    let cached = BudgetedReader {
        inner: reader,
        state: RefCell::new(ReadBudgetState {
            bytes: BTreeMap::new(),
            visits: 0,
            read_bytes: 0,
        }),
        max_visits,
        max_read_bytes,
    };
    let mut ids = BTreeSet::new();
    let mut total_bytes = 0u64;
    for root in roots {
        let view = SnapshotView::open(&cached, *root).await?;
        for id in view.reachable_ids_bounded(max_objects, max_bytes).await? {
            if ids.insert(id) {
                if ids.len() > max_objects {
                    return Err(Error::Limit);
                }
                let size = cached
                    .state
                    .borrow()
                    .bytes
                    .get(&id)
                    .map(Vec::len)
                    .ok_or(Error::Integrity)?;
                total_bytes = total_bytes.checked_add(size as u64).ok_or(Error::Limit)?;
                if total_bytes > max_bytes {
                    return Err(Error::Limit);
                }
            }
        }
    }
    Ok(ids.into_iter().collect())
}

struct ReadBudgetState {
    bytes: BTreeMap<ContentId, Vec<u8>>,
    visits: usize,
    read_bytes: u64,
}

struct BudgetedReader<'a, R> {
    inner: &'a R,
    state: RefCell<ReadBudgetState>,
    max_visits: usize,
    max_read_bytes: u64,
}

impl<R: ObjectReader> ObjectReader for BudgetedReader<'_, R> {
    async fn get(&self, id: ContentId, max_bytes: usize) -> Result<Vec<u8>, Error> {
        {
            let mut state = self.state.borrow_mut();
            state.visits = state.visits.checked_add(1).ok_or(Error::Limit)?;
            if state.visits > self.max_visits {
                return Err(Error::Limit);
            }
            if let Some(bytes) = state.bytes.get(&id) {
                if bytes.len() > max_bytes {
                    return Err(Error::Limit);
                }
                return Ok(bytes.clone());
            }
        }
        let remaining = self
            .max_read_bytes
            .saturating_sub(self.state.borrow().read_bytes);
        if remaining == 0 {
            return Err(Error::Limit);
        }
        let cap = max_bytes.min(usize::try_from(remaining).unwrap_or(usize::MAX));
        let bytes = self.inner.get(id, cap).await?;
        if bytes.len() > cap || ContentId::for_bytes(&bytes) != id {
            return Err(Error::Integrity);
        }
        let mut state = self.state.borrow_mut();
        state.read_bytes = state
            .read_bytes
            .checked_add(bytes.len() as u64)
            .ok_or(Error::Limit)?;
        if state.read_bytes > self.max_read_bytes {
            return Err(Error::Limit);
        }
        state.bytes.insert(id, bytes.clone());
        Ok(bytes)
    }
}

/// Root-pinned reader. No mutable-head following or implicit generation changes.
pub struct SnapshotView<'a, R> {
    reader: &'a R,
    id: ContentId,
    snapshot: Snapshot,
}
/// Metadata-only verification result; file payloads are checked on access.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeStats {
    pub nodes: usize,
    pub max_inode: u64,
    pub file_bytes: u64,
}
impl<'a, R: ObjectReader> SnapshotView<'a, R> {
    pub async fn open(reader: &'a R, id: ContentId) -> Result<Self, Error> {
        let manifest = load(reader, id).await?;
        let Node::Snapshot(snapshot) = manifest.node else {
            return Err(Error::Invalid("expected snapshot"));
        };
        checked_node(reader, &snapshot.root).await?;
        Ok(Self {
            reader,
            id,
            snapshot,
        })
    }
    pub fn id(&self) -> ContentId {
        self.id
    }
    pub fn snapshot(&self) -> &Snapshot {
        &self.snapshot
    }
    pub async fn lookup(&self, path: &str) -> Result<NodeRef, Error> {
        self.lookup_checked(path)
            .await
            .map(|(reference, _)| reference)
    }
    async fn lookup_checked(&self, path: &str) -> Result<(NodeRef, Node), Error> {
        let components = path_components(path)?;
        let mut current = self.snapshot.root.clone();
        for component in components {
            let Node::Directory(dir) = checked_node(self.reader, &current).await? else {
                return Err(Error::NotDirectory);
            };
            current = dir
                .entries
                .binary_search_by(|entry| entry.name.as_str().cmp(component))
                .ok()
                .and_then(|index| dir.entries.get(index))
                .ok_or(Error::NotFound)?
                .node
                .clone();
        }
        let node = checked_node(self.reader, &current).await?;
        Ok((current, node))
    }
    pub async fn stat(&self, path: &str) -> Result<Node, Error> {
        self.lookup_checked(path).await.map(|(_, node)| node)
    }
    pub async fn list(&self, path: &str) -> Result<Vec<Entry>, Error> {
        let Node::Directory(dir) = self.stat(path).await? else {
            return Err(Error::NotDirectory);
        };
        Ok(dir.entries)
    }
    pub async fn read_range(
        &self,
        path: &str,
        offset: u64,
        length: usize,
    ) -> Result<Vec<u8>, Error> {
        if length > MAX_READ_BYTES {
            return Err(Error::Limit);
        }
        let Node::File(file) = self.stat(path).await? else {
            return Err(Error::NotFile);
        };
        if offset >= file.size || length == 0 {
            return Ok(Vec::new());
        }
        let end = offset
            .checked_add(length as u64)
            .ok_or(Error::Limit)?
            .min(file.size);
        let mut output = Vec::with_capacity((end - offset) as usize);
        let mut start = 0u64;
        for chunk in file.chunks {
            let chunk_end = start + u64::from(chunk.size);
            if start >= end {
                break;
            }
            if chunk_end > offset {
                let bytes = self.reader.get(chunk.content, chunk.size as usize).await?;
                if bytes.len() != chunk.size as usize
                    || ContentId::for_bytes(&bytes) != chunk.content
                {
                    return Err(Error::Integrity);
                }
                let lo = offset.saturating_sub(start) as usize;
                let hi = (end.min(chunk_end) - start) as usize;
                output.extend_from_slice(&bytes[lo..hi]);
            }
            start = chunk_end;
        }
        Ok(output)
    }
    /// Validate all metadata references and global inode uniqueness without
    /// fetching file payloads. Mount adapters must call this before exposure.
    /// Node/depth/frontier budgets bound hostile trees. Availability of file
    /// chunks and history/authority are separate checks.
    pub async fn validate_tree(&self) -> Result<usize, Error> {
        self.validate_tree_stats().await.map(|stats| stats.nodes)
    }
    pub async fn validate_tree_stats(&self) -> Result<TreeStats, Error> {
        let mut stack = vec![(self.snapshot.root.clone(), 0usize)];
        let mut seen = BTreeSet::new();
        let mut visited = 0;
        let mut max_inode = 0;
        let mut file_bytes = 0u64;
        while let Some((reference, depth)) = stack.pop() {
            if depth > MAX_DEPTH || visited >= MAX_TREE_NODES {
                return Err(Error::Limit);
            }
            if !seen.insert(reference.inode) {
                return Err(Error::Invalid("inode alias"));
            }
            visited += 1;
            max_inode = max_inode.max(reference.inode);
            match checked_node(self.reader, &reference).await? {
                Node::Directory(dir) => {
                    if stack.len() + dir.entries.len() > MAX_TREE_NODES {
                        return Err(Error::Limit);
                    }
                    stack.extend(dir.entries.into_iter().map(|e| (e.node, depth + 1)));
                }
                Node::File(file) => {
                    file_bytes = file_bytes.checked_add(file.size).ok_or(Error::Limit)?;
                }
                Node::Snapshot(_) => return Err(Error::Invalid("snapshot used as node")),
            }
        }
        Ok(TreeStats {
            nodes: visited,
            max_inode,
            file_bytes,
        })
    }

    /// Enumerate every object a pinned root needs, including file payloads.
    /// A failed scan must never be used as permission to delete local objects.
    pub async fn reachable_ids_bounded(
        &self,
        max_objects: usize,
        max_bytes: u64,
    ) -> Result<Vec<ContentId>, Error> {
        self.validate_tree_stats().await?;
        let mut seen = BTreeSet::new();
        let mut verified_chunks = BTreeMap::new();
        let mut total_bytes = 0u64;
        let mut add = |id: ContentId, size: usize| -> Result<(), Error> {
            if seen.insert(id) {
                if seen.len() > max_objects {
                    return Err(Error::Limit);
                }
                total_bytes = total_bytes.checked_add(size as u64).ok_or(Error::Limit)?;
                if total_bytes > max_bytes {
                    return Err(Error::Limit);
                }
            }
            Ok(())
        };
        let snapshot_bytes = Manifest::new(Node::Snapshot(self.snapshot.clone())).encode()?;
        add(self.id, snapshot_bytes.len())?;
        let mut stack = vec![self.snapshot.root.clone()];
        while let Some(reference) = stack.pop() {
            let node = checked_node(self.reader, &reference).await?;
            let manifest_bytes = Manifest::new(node.clone()).encode()?;
            add(reference.manifest, manifest_bytes.len())?;
            match node {
                Node::Directory(directory) => {
                    stack.extend(directory.entries.into_iter().map(|entry| entry.node));
                }
                Node::File(file) => {
                    for chunk in file.chunks {
                        if let Some(size) = verified_chunks.get(&chunk.content) {
                            if *size != chunk.size {
                                return Err(Error::Integrity);
                            }
                            continue;
                        }
                        let bytes = self.reader.get(chunk.content, chunk.size as usize).await?;
                        if bytes.len() != chunk.size as usize
                            || ContentId::for_bytes(&bytes) != chunk.content
                        {
                            return Err(Error::Integrity);
                        }
                        verified_chunks.insert(chunk.content, chunk.size);
                        add(chunk.content, bytes.len())?;
                    }
                }
                Node::Snapshot(_) => return Err(Error::Invalid("snapshot used as node")),
            }
        }
        Ok(seen.into_iter().collect())
    }
}
async fn load<R: ObjectReader>(reader: &R, id: ContentId) -> Result<Manifest, Error> {
    Manifest::decode(id, &reader.get(id, MAX_MANIFEST_BYTES).await?)
}
async fn checked_node<R: ObjectReader>(reader: &R, reference: &NodeRef) -> Result<Node, Error> {
    let node = load(reader, reference.manifest).await?.node;
    let (actual_inode, kind) = match &node {
        Node::Directory(dir) => (dir.inode, NodeKind::Directory),
        Node::File(file) => (file.inode, NodeKind::File),
        Node::Snapshot(_) => return Err(Error::Invalid("snapshot used as node")),
    };
    if actual_inode != reference.inode || kind != reference.kind {
        return Err(Error::Invalid("node reference"));
    }
    Ok(node)
}
fn path_components(path: &str) -> Result<Vec<&str>, Error> {
    if path.len() > 4096 {
        return Err(Error::Limit);
    }
    if !path.starts_with('/') {
        return Err(Error::Invalid("absolute path required"));
    }
    if path == "/" {
        return Ok(Vec::new());
    }
    let parts: Vec<_> = path[1..].split('/').collect();
    if parts.len() > MAX_DEPTH {
        return Err(Error::Limit);
    }
    for part in &parts {
        name(part)?;
    }
    Ok(parts)
}
