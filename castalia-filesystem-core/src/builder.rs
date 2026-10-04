//! Portable, bounded generation-zero snapshot producer for streaming hosts.
//! A browser ZIP Worker may feed chunks without copying an entire archive into
//! Rust memory. Objects are staged before the snapshot ID is acknowledged.

use crate::*;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

enum Draft {
    Directory {
        modified_ms: u64,
        explicit: bool,
        entries: BTreeMap<String, Draft>,
    },
    File {
        modified_ms: u64,
        executable: bool,
        chunks: Vec<Chunk>,
        size: u64,
    },
}

struct ActiveFile {
    path: String,
    modified_ms: u64,
    executable: bool,
    chunks: Vec<Chunk>,
    size: u64,
}

pub struct SnapshotBuilder {
    namespace: ContentId,
    root: Draft,
    active: Option<ActiveFile>,
    nodes: usize,
}

impl SnapshotBuilder {
    pub fn new(namespace: ContentId, modified_ms: u64) -> Result<Self, Error> {
        integer(modified_ms)?;
        Ok(Self {
            namespace,
            root: Draft::Directory {
                modified_ms,
                explicit: true,
                entries: BTreeMap::new(),
            },
            active: None,
            nodes: 1,
        })
    }

    pub fn add_directory(&mut self, path: &str, modified_ms: u64) -> Result<(), Error> {
        if self.active.is_some() {
            return Err(Error::Invalid("active file"));
        }
        integer(modified_ms)?;
        let parts = path_components(path)?;
        if parts.is_empty() {
            return Err(Error::Invalid("root already exists"));
        }
        let leaf = parts.last().expect("nonempty path");
        let parent = Self::parent(&mut self.root, &mut self.nodes, &parts[..parts.len() - 1])?;
        match parent.get_mut(*leaf) {
            Some(Draft::Directory {
                modified_ms: time,
                explicit,
                ..
            }) if !*explicit => {
                *time = modified_ms;
                *explicit = true;
                Ok(())
            }
            Some(_) => Err(Error::Invalid("duplicate path")),
            None => {
                Self::add_node(&mut self.nodes)?;
                parent.insert(
                    (*leaf).into(),
                    Draft::Directory {
                        modified_ms,
                        explicit: true,
                        entries: BTreeMap::new(),
                    },
                );
                Ok(())
            }
        }
    }

    pub fn begin_file(
        &mut self,
        path: &str,
        modified_ms: u64,
        executable: bool,
    ) -> Result<(), Error> {
        if self.active.is_some() {
            return Err(Error::Invalid("active file"));
        }
        integer(modified_ms)?;
        if path_components(path)?.is_empty() {
            return Err(Error::Invalid("file root"));
        }
        self.active = Some(ActiveFile {
            path: path.into(),
            modified_ms,
            executable,
            chunks: Vec::new(),
            size: 0,
        });
        Ok(())
    }

    pub async fn append_chunk<S: ObjectWriter>(
        &mut self,
        store: &S,
        bytes: &[u8],
    ) -> Result<(), Error> {
        let file = self
            .active
            .as_mut()
            .ok_or(Error::Invalid("no active file"))?;
        if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES || file.chunks.len() >= MAX_CHUNKS {
            return Err(Error::Limit);
        }
        let next_size = file
            .size
            .checked_add(bytes.len() as u64)
            .ok_or(Error::Limit)?;
        integer(next_size)?;
        let expected = ContentId::for_bytes(bytes);
        if store.put(bytes).await? != expected {
            return Err(Error::Integrity);
        }
        file.chunks.push(Chunk {
            content: expected,
            size: bytes.len() as u32,
        });
        file.size = next_size;
        Ok(())
    }

    pub fn finish_file(&mut self) -> Result<(), Error> {
        let file = self.active.take().ok_or(Error::Invalid("no active file"))?;
        let parts = path_components(&file.path)?;
        let leaf = parts.last().expect("nonempty file path");
        let parent = Self::parent(&mut self.root, &mut self.nodes, &parts[..parts.len() - 1])?;
        if parent.contains_key(*leaf) {
            return Err(Error::Invalid("duplicate path"));
        }
        Self::add_node(&mut self.nodes)?;
        parent.insert(
            (*leaf).into(),
            Draft::File {
                modified_ms: file.modified_ms,
                executable: file.executable,
                chunks: file.chunks,
                size: file.size,
            },
        );
        Ok(())
    }

    pub async fn finish<S: ObjectWriter>(self, store: &S) -> Result<ContentId, Error> {
        if self.active.is_some() {
            return Err(Error::Invalid("active file"));
        }
        let mut next_inode = 1;
        let root = write_node(store, self.root, &mut next_inode).await?;
        put_checked(
            store,
            &Manifest::new(Node::Snapshot(Snapshot {
                namespace: self.namespace,
                generation: 0,
                previous: None,
                root,
            }))
            .encode()?,
        )
        .await
    }

    fn add_node(nodes: &mut usize) -> Result<(), Error> {
        if *nodes >= MAX_TREE_NODES {
            return Err(Error::Limit);
        }
        *nodes += 1;
        Ok(())
    }

    fn parent<'a>(
        root: &'a mut Draft,
        nodes: &mut usize,
        parts: &[&str],
    ) -> Result<&'a mut BTreeMap<String, Draft>, Error> {
        let mut current = root;
        for part in parts {
            let Draft::Directory { entries, .. } = current else {
                return Err(Error::NotDirectory);
            };
            if !entries.contains_key(*part) {
                if entries.len() >= MAX_ENTRIES {
                    return Err(Error::Limit);
                }
                Self::add_node(nodes)?;
                entries.insert(
                    (*part).into(),
                    Draft::Directory {
                        modified_ms: 0,
                        explicit: false,
                        entries: BTreeMap::new(),
                    },
                );
            }
            current = entries.get_mut(*part).expect("inserted or present");
        }
        match current {
            Draft::Directory { entries, .. } => {
                if entries.len() >= MAX_ENTRIES {
                    return Err(Error::Limit);
                }
                Ok(entries)
            }
            Draft::File { .. } => Err(Error::NotDirectory),
        }
    }
}

async fn put_checked<S: ObjectWriter>(store: &S, bytes: &[u8]) -> Result<ContentId, Error> {
    let expected = ContentId::for_bytes(bytes);
    if store.put(bytes).await? != expected {
        return Err(Error::Integrity);
    }
    Ok(expected)
}

type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, Error>> + 'a>>;

fn write_node<'a, S: ObjectWriter + 'a>(
    store: &'a S,
    draft: Draft,
    next_inode: &'a mut u64,
) -> LocalFuture<'a, NodeRef> {
    Box::pin(async move {
        if *next_inode > MAX_TREE_NODES as u64 {
            return Err(Error::Limit);
        }
        let logical = *next_inode;
        *next_inode += 1;
        let (kind, node) = match draft {
            Draft::Directory {
                modified_ms,
                entries,
                ..
            } => {
                let mut output = Vec::with_capacity(entries.len());
                for (name, child) in entries {
                    let reference = write_node(store, child, next_inode).await?;
                    output.push(Entry {
                        name,
                        node: reference,
                    });
                }
                (
                    NodeKind::Directory,
                    Node::Directory(Directory::new(logical, modified_ms, output)?),
                )
            }
            Draft::File {
                modified_ms,
                executable,
                chunks,
                size,
            } => (
                NodeKind::File,
                Node::File(File {
                    inode: logical,
                    modified_ms,
                    executable,
                    size,
                    chunks,
                }),
            ),
        };
        let manifest = put_checked(store, &Manifest::new(node).encode()?).await?;
        Ok(NodeRef {
            inode: logical,
            kind,
            manifest,
        })
    })
}
