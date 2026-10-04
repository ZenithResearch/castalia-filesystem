//! Copy-on-write file replacement/addition over a pinned snapshot.
//! This produces a new immutable root; selecting a mutable workspace head is
//! the host catalog's separate expected-root transaction.

use crate::*;

pub struct StagedFile {
    pub modified_ms: u64,
    pub executable: bool,
    pub chunks: Vec<Chunk>,
}

/// Replace an existing file or add a file within an existing directory.
/// Unchanged node references keep their manifest IDs and logical inodes.
/// New file inodes are allocated above the maximum inode in the base tree.
/// The caller must stage chunks first; this function verifies every staged
/// chunk before acknowledging a new root, but does not perform head CAS.
pub async fn revise_file<S: ObjectReader + ObjectWriter>(
    store: &S,
    base: ContentId,
    path: &str,
    staged: StagedFile,
) -> Result<ContentId, Error> {
    revise_file_inner(store, base, path, staged, true).await
}

/// Create a file only when the leaf path is absent. Existing files and
/// directories are never replaced by this operation.
pub async fn create_file<S: ObjectReader + ObjectWriter>(
    store: &S,
    base: ContentId,
    path: &str,
    staged: StagedFile,
) -> Result<ContentId, Error> {
    revise_file_inner(store, base, path, staged, false).await
}

async fn revise_file_inner<S: ObjectReader + ObjectWriter>(
    store: &S,
    base: ContentId,
    path: &str,
    staged: StagedFile,
    replace_existing: bool,
) -> Result<ContentId, Error> {
    integer(staged.modified_ms)?;
    let parts = path_components(path)?;
    if parts.is_empty() {
        return Err(Error::Invalid("file root"));
    }
    let view = SnapshotView::open(store, base).await?;
    let max_inode = view.validate_tree_stats().await?.max_inode;

    let mut ancestry = Vec::new();
    let mut current = view.snapshot().root.clone();
    for component in &parts[..parts.len() - 1] {
        let Node::Directory(directory) = checked_node(store, &current).await? else {
            return Err(Error::NotDirectory);
        };
        let child = directory
            .entries
            .iter()
            .find(|entry| entry.name == *component)
            .ok_or(Error::NotFound)?
            .node
            .clone();
        ancestry.push((directory, (*component).to_owned()));
        current = child;
    }
    let Node::Directory(mut parent) = checked_node(store, &current).await? else {
        return Err(Error::NotDirectory);
    };
    let leaf = parts.last().expect("nonempty path");
    let existing = parent.entries.iter().position(|entry| entry.name == *leaf);
    let logical = match existing {
        Some(_) if !replace_existing => return Err(Error::Invalid("entry exists")),
        Some(index) if parent.entries[index].node.kind == NodeKind::File => {
            parent.entries[index].node.inode
        }
        Some(_) => return Err(Error::NotFile),
        None => max_inode.checked_add(1).ok_or(Error::Limit)?,
    };
    inode(logical)?;
    if existing.is_none() && parent.entries.len() >= MAX_ENTRIES {
        return Err(Error::Limit);
    }
    if staged.chunks.len() > MAX_CHUNKS {
        return Err(Error::Limit);
    }
    let mut size = 0u64;
    for chunk in &staged.chunks {
        if chunk.size == 0 || chunk.size as usize > MAX_CHUNK_BYTES {
            return Err(Error::Invalid("chunk size"));
        }
        let bytes = store.get(chunk.content, chunk.size as usize).await?;
        if bytes.len() != chunk.size as usize || ContentId::for_bytes(&bytes) != chunk.content {
            return Err(Error::Integrity);
        }
        size = size
            .checked_add(u64::from(chunk.size))
            .ok_or(Error::Limit)?;
    }
    integer(size)?;
    let file_manifest = put_checked(
        store,
        &Manifest::new(Node::File(File {
            inode: logical,
            modified_ms: staged.modified_ms,
            executable: staged.executable,
            size,
            chunks: staged.chunks,
        }))
        .encode()?,
    )
    .await?;
    let mut changed = NodeRef {
        inode: logical,
        kind: NodeKind::File,
        manifest: file_manifest,
    };
    if let Some(index) = existing {
        parent.entries[index].node = changed;
    } else {
        parent.entries.push(Entry {
            name: (*leaf).into(),
            node: changed,
        });
    }
    changed = write_directory(store, parent).await?;
    for (mut directory, component) in ancestry.into_iter().rev() {
        let entry = directory
            .entries
            .iter_mut()
            .find(|entry| entry.name == component)
            .ok_or(Error::NotFound)?;
        entry.node = changed;
        changed = write_directory(store, directory).await?;
    }
    write_revision_snapshot(store, base, view.snapshot(), changed).await
}

/// Add an empty directory within an existing directory. Unchanged nodes keep
/// their content IDs and logical inodes; the new directory gets a fresh inode.
pub async fn create_directory<S: ObjectReader + ObjectWriter>(
    store: &S,
    base: ContentId,
    path: &str,
    modified_ms: u64,
) -> Result<ContentId, Error> {
    integer(modified_ms)?;
    let parts = path_components(path)?;
    if parts.is_empty() {
        return Err(Error::Invalid("directory root"));
    }
    let view = SnapshotView::open(store, base).await?;
    let max_inode = view.validate_tree_stats().await?.max_inode;
    let logical = max_inode.checked_add(1).ok_or(Error::Limit)?;
    inode(logical)?;

    let mut ancestry = Vec::new();
    let mut current = view.snapshot().root.clone();
    for component in &parts[..parts.len() - 1] {
        let Node::Directory(directory) = checked_node(store, &current).await? else {
            return Err(Error::NotDirectory);
        };
        let child = directory
            .entries
            .iter()
            .find(|entry| entry.name == *component)
            .ok_or(Error::NotFound)?
            .node
            .clone();
        ancestry.push((directory, (*component).to_owned()));
        current = child;
    }
    let Node::Directory(mut parent) = checked_node(store, &current).await? else {
        return Err(Error::NotDirectory);
    };
    let leaf = parts.last().expect("nonempty path");
    if parent.entries.iter().any(|entry| entry.name == *leaf) {
        return Err(Error::Invalid("entry exists"));
    }
    if parent.entries.len() >= MAX_ENTRIES {
        return Err(Error::Limit);
    }
    let child = write_directory(
        store,
        Directory {
            inode: logical,
            modified_ms,
            entries: Vec::new(),
        },
    )
    .await?;
    parent.entries.push(Entry {
        name: (*leaf).into(),
        node: child,
    });
    let mut changed = write_directory(store, parent).await?;
    for (mut directory, component) in ancestry.into_iter().rev() {
        let entry = directory
            .entries
            .iter_mut()
            .find(|entry| entry.name == component)
            .ok_or(Error::NotFound)?;
        entry.node = changed;
        changed = write_directory(store, directory).await?;
    }
    write_revision_snapshot(store, base, view.snapshot(), changed).await
}

async fn write_revision_snapshot<S: ObjectWriter>(
    store: &S,
    base: ContentId,
    previous: &Snapshot,
    root: NodeRef,
) -> Result<ContentId, Error> {
    let generation = previous.generation.checked_add(1).ok_or(Error::Limit)?;
    integer(generation)?;
    put_checked(
        store,
        &Manifest::new(Node::Snapshot(Snapshot {
            namespace: previous.namespace,
            generation,
            previous: Some(base),
            root,
        }))
        .encode()?,
    )
    .await
}

async fn write_directory<S: ObjectWriter>(
    store: &S,
    directory: Directory,
) -> Result<NodeRef, Error> {
    let inode = directory.inode;
    let manifest = put_checked(
        store,
        &Manifest::new(Node::Directory(Directory::new(
            inode,
            directory.modified_ms,
            directory.entries,
        )?))
        .encode()?,
    )
    .await?;
    Ok(NodeRef {
        inode,
        kind: NodeKind::Directory,
        manifest,
    })
}

async fn put_checked<S: ObjectWriter>(store: &S, bytes: &[u8]) -> Result<ContentId, Error> {
    let expected = ContentId::for_bytes(bytes);
    if store.put(bytes).await? != expected {
        return Err(Error::Integrity);
    }
    Ok(expected)
}
