//! Unix directory-fd-contained local CAS and streaming filesystem import/export.
//! Disk operations are synchronous: invoke on a blocking worker in GUI/servers.

use crate::*;
use rustix::fs::{self as fd, AtFlags, Mode, OFlags};
use std::fs::File as DiskFile;
use std::future::Future;
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn io(error: impl std::fmt::Display) -> Error {
    Error::Transport(error.to_string())
}
fn open_dir(path: &Path) -> Result<DiskFile, Error> {
    Ok(fd::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(io)?
    .into())
}
fn open_child(parent: &DiskFile, name: &str, flags: OFlags) -> Result<DiskFile, Error> {
    crate::name(name)?;
    Ok(fd::openat(
        parent,
        name,
        flags | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(io)?
    .into())
}

/// Owner-private directory pinned by fd. Named records use no-overwrite atomic
/// link publication after file fsync; directory fsync precedes success.
/// Existing paths must already be private. Intermediate selected path parents
/// are trusted; all record operations are fd-relative and reject symlinks.
pub struct PrivateDirectory {
    dir: DiskFile,
    path: PathBuf,
}
impl PrivateDirectory {
    pub fn open(path: &Path) -> Result<Self, Error> {
        match std::fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(io(e)),
        }
        let dir = open_dir(path)?;
        let meta = dir.metadata().map_err(io)?;
        if meta.uid() != rustix::process::geteuid().as_raw() || meta.mode() & 0o077 != 0 {
            return Err(Error::Invalid("store directory must be owner-private"));
        }
        // Persist directory creation in its selected parent, too.
        let absolute = std::fs::canonicalize(path).map_err(io)?;
        let parent = open_dir(absolute.parent().ok_or(Error::Invalid("store parent"))?)?;
        fd::fsync(&parent).map_err(io)?;
        Ok(Self {
            dir,
            path: absolute,
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn read_named(&self, name: &str, cap: usize) -> Result<Option<Vec<u8>>, Error> {
        crate::name(name)?;
        let raw = match fd::openat(
            &self.dir,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        ) {
            Ok(file) => file,
            Err(e) if e == rustix::io::Errno::NOENT => return Ok(None),
            Err(e) => return Err(io(e)),
        };
        let file: DiskFile = raw.into();
        let meta = file.metadata().map_err(io)?;
        if !meta.is_file()
            || meta.uid() != rustix::process::geteuid().as_raw()
            || meta.mode() & 0o077 != 0
        {
            return Err(Error::Invalid("record must be owner-private regular file"));
        }
        if meta.len() > cap as u64 {
            return Err(Error::Limit);
        }
        let mut bytes = Vec::new();
        file.take(cap.checked_add(1).ok_or(Error::Limit)? as u64)
            .read_to_end(&mut bytes)
            .map_err(io)?;
        if bytes.len() > cap {
            return Err(Error::Limit);
        }
        Ok(Some(bytes))
    }
    pub fn write_once(&self, name: &str, bytes: &[u8], cap: usize) -> Result<(), Error> {
        crate::name(name)?;
        if bytes.len() > cap {
            return Err(Error::Limit);
        }
        if let Some(existing) = self.read_named(name, cap)? {
            if existing != bytes {
                return Err(Error::Integrity);
            }
            fd::fsync(&self.dir).map_err(io)?;
            return Ok(());
        }
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        let temporary = format!(
            ".tmp-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        );
        let mut file = open_child(
            &self.dir,
            &temporary,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
        )?;
        struct Cleanup<'a> {
            parent: &'a DiskFile,
            name: &'a str,
        }
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = fd::unlinkat(self.parent, self.name, AtFlags::empty());
            }
        }
        let _cleanup = Cleanup {
            parent: &self.dir,
            name: &temporary,
        };
        file.write_all(bytes).map_err(io)?;
        file.sync_all().map_err(io)?;
        match fd::linkat(&self.dir, &temporary, &self.dir, name, AtFlags::empty()) {
            Ok(()) => (),
            Err(e) if e == rustix::io::Errno::EXIST => {
                if self.read_named(name, cap)?.as_deref() != Some(bytes) {
                    return Err(Error::Integrity);
                }
            }
            Err(e) => return Err(io(e)),
        }
        fd::fsync(&self.dir).map_err(io)?;
        Ok(())
    }
}
use std::os::unix::fs::DirBuilderExt;

/// Durable local plaintext store, not encrypted storage or an evicting cache.
pub struct DiskStore {
    records: PrivateDirectory,
}
impl DiskStore {
    pub fn open(path: &Path) -> Result<Self, Error> {
        Ok(Self {
            records: PrivateDirectory::open(path)?,
        })
    }
    pub fn path(&self) -> &Path {
        self.records.path()
    }
}
impl ObjectReader for DiskStore {
    async fn get(&self, id: ContentId, cap: usize) -> Result<Vec<u8>, Error> {
        let cap = cap.min(MAX_MANIFEST_BYTES.max(MAX_CHUNK_BYTES));
        let bytes = self
            .records
            .read_named(&String::from(id), cap)?
            .ok_or(Error::Unavailable)?;
        if ContentId::for_bytes(&bytes) != id {
            return Err(Error::Integrity);
        }
        Ok(bytes)
    }
}
impl ObjectWriter for DiskStore {
    async fn put(&self, bytes: &[u8]) -> Result<ContentId, Error> {
        let id = ContentId::for_bytes(bytes);
        self.records.write_once(
            &String::from(id),
            bytes,
            MAX_MANIFEST_BYTES.max(MAX_CHUNK_BYTES),
        )?;
        Ok(id)
    }
}

async fn put_checked<S: ObjectWriter>(store: &S, bytes: &[u8]) -> Result<ContentId, Error> {
    let expected = ContentId::for_bytes(bytes);
    if store.put(bytes).await? != expected {
        return Err(Error::Integrity);
    }
    Ok(expected)
}
fn mtime(meta: &std::fs::Metadata) -> Result<u64, Error> {
    let millis = meta
        .modified()
        .map_err(io)?
        .duration_since(UNIX_EPOCH)
        .map_err(io)?
        .as_millis();
    let millis = u64::try_from(millis).map_err(|_| Error::Limit)?;
    crate::integer(millis)?;
    Ok(millis)
}
fn unchanged(before: &std::fs::Metadata, after: &std::fs::Metadata) -> Result<(), Error> {
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(Error::Invalid("source changed during import"));
    }
    Ok(())
}
type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, Error>> + 'a>>;
fn import_node<'a, S: ObjectWriter + 'a>(
    store: &'a S,
    mut file: DiskFile,
    depth: usize,
    path_bytes: usize,
    next_inode: &'a mut u64,
) -> LocalFuture<'a, NodeRef> {
    Box::pin(async move {
        if depth > MAX_DEPTH || path_bytes > 4096 || *next_inode > MAX_TREE_NODES as u64 {
            return Err(Error::Limit);
        }
        let logical = *next_inode;
        *next_inode += 1;
        let before = file.metadata().map_err(io)?;
        let modified_ms = mtime(&before)?;
        let (kind, node) = if before.is_dir() {
            let mut names = Vec::new();
            for entry in fd::Dir::read_from(&file).map_err(io)? {
                let entry = entry.map_err(io)?;
                let bytes = entry.file_name().to_bytes();
                if bytes == b"." || bytes == b".." {
                    continue;
                }
                let child =
                    std::str::from_utf8(bytes).map_err(|_| Error::Invalid("non-UTF8 filename"))?;
                crate::name(child)?;
                if names.len() >= MAX_ENTRIES {
                    return Err(Error::Limit);
                }
                names.push(child.to_owned());
            }
            names.sort();
            let mut entries = Vec::new();
            for child in names {
                let stat = fd::statat(&file, &child, AtFlags::SYMLINK_NOFOLLOW).map_err(io)?;
                let kind = fd::FileType::from_raw_mode(stat.st_mode);
                if kind != fd::FileType::RegularFile && kind != fd::FileType::Directory {
                    return Err(Error::Invalid("symlink or special source file"));
                }
                let child_fd = open_child(&file, &child, OFlags::RDONLY)?;
                let reference = import_node(
                    store,
                    child_fd,
                    depth + 1,
                    path_bytes + child.len() + 1,
                    next_inode,
                )
                .await?;
                entries.push(Entry {
                    name: child,
                    node: reference,
                });
            }
            (
                NodeKind::Directory,
                Node::Directory(Directory::new(logical, modified_ms, entries)?),
            )
        } else if before.is_file() {
            if before.len() > (MAX_CHUNKS * MAX_CHUNK_BYTES) as u64 {
                return Err(Error::Limit);
            }
            let mut chunks = Vec::new();
            let mut size = 0u64;
            loop {
                let mut bytes = vec![0; MAX_CHUNK_BYTES];
                let mut filled = 0;
                while filled < bytes.len() {
                    match file.read(&mut bytes[filled..]) {
                        Ok(0) => break,
                        Ok(count) => filled += count,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) => return Err(io(e)),
                    }
                }
                if filled == 0 {
                    break;
                }
                if chunks.len() >= MAX_CHUNKS {
                    return Err(Error::Limit);
                }
                bytes.truncate(filled);
                let content = put_checked(store, &bytes).await?;
                chunks.push(Chunk {
                    content,
                    size: filled as u32,
                });
                size += filled as u64;
            }
            if size != before.len() {
                return Err(Error::Invalid("source size changed"));
            }
            (
                NodeKind::File,
                Node::File(crate::File {
                    inode: logical,
                    modified_ms,
                    executable: before.mode() & 0o111 != 0,
                    size,
                    chunks,
                }),
            )
        } else {
            return Err(Error::Invalid("special source file"));
        };
        unchanged(&before, &file.metadata().map_err(io)?)?;
        let manifest = put_checked(store, &Manifest::new(node).encode()?).await?;
        Ok(NodeRef {
            inode: logical,
            kind,
            manifest,
        })
    })
}

/// Initial generation only. Inodes allocated deterministically by sorted walk;
/// reimport is a new namespace image, not stable-identity editing/merge.
/// Caller must freeze the source tree; per-file/dir change checks are best effort.
pub async fn import_directory<S: ObjectWriter>(
    store: &S,
    source: &Path,
    namespace: ContentId,
) -> Result<ContentId, Error> {
    let dir = open_dir(source)?;
    let mut next_inode = 1;
    let root = import_node(store, dir, 0, 0, &mut next_inode).await?;
    put_checked(
        store,
        &Manifest::new(Node::Snapshot(Snapshot {
            namespace,
            generation: 0,
            previous: None,
            root,
        }))
        .encode()?,
    )
    .await
}

fn set_metadata(file: &DiskFile, modified_ms: u64, executable: bool) -> Result<(), Error> {
    fd::fchmod(
        file,
        if executable {
            Mode::RUSR | Mode::WUSR | Mode::XUSR
        } else {
            Mode::RUSR | Mode::WUSR
        },
    )
    .map_err(io)?;
    let modified: SystemTime = UNIX_EPOCH
        .checked_add(Duration::from_millis(modified_ms))
        .ok_or(Error::Limit)?;
    file.set_times(std::fs::FileTimes::new().set_modified(modified))
        .map_err(io)?;
    file.sync_all().map_err(io)
}
fn export_node<'a, R: ObjectReader + 'a>(
    reader: &'a R,
    reference: NodeRef,
    mut output: DiskFile,
) -> LocalFuture<'a, ()> {
    Box::pin(async move {
        match crate::checked_node(reader, &reference).await? {
            Node::Directory(directory) => {
                for entry in directory.entries {
                    let child = match entry.node.kind {
                        NodeKind::Directory => {
                            fd::mkdirat(&output, &entry.name, Mode::RUSR | Mode::WUSR | Mode::XUSR)
                                .map_err(io)?;
                            open_child(&output, &entry.name, OFlags::RDONLY | OFlags::DIRECTORY)?
                        }
                        NodeKind::File => open_child(
                            &output,
                            &entry.name,
                            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
                        )?,
                    };
                    export_node(reader, entry.node, child).await?;
                }
                set_metadata(&output, directory.modified_ms, true)?;
            }
            Node::File(file) => {
                for chunk in file.chunks {
                    let bytes = reader.get(chunk.content, chunk.size as usize).await?;
                    if bytes.len() != chunk.size as usize
                        || ContentId::for_bytes(&bytes) != chunk.content
                    {
                        return Err(Error::Integrity);
                    }
                    output.write_all(&bytes).map_err(io)?;
                }
                set_metadata(&output, file.modified_ms, file.executable)?;
            }
            Node::Snapshot(_) => return Err(Error::Invalid("snapshot as child")),
        }
        Ok(())
    })
}

/// Destination must not exist. Writes stay under directory fds, never overwrite
/// or follow symlinks. Failure can leave a clearly unsuccessful partial export.
pub async fn export_directory<R: ObjectReader>(
    reader: &R,
    snapshot: ContentId,
    destination: &Path,
) -> Result<(), Error> {
    let view = SnapshotView::open(reader, snapshot).await?;
    view.validate_tree().await?;
    let parent_path = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = open_dir(parent_path)?;
    let leaf = destination
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(Error::Invalid("export destination"))?;
    crate::name(leaf)?;
    fd::mkdirat(&parent, leaf, Mode::RUSR | Mode::WUSR | Mode::XUSR).map_err(io)?;
    let output = open_child(&parent, leaf, OFlags::RDONLY | OFlags::DIRECTORY)?;
    export_node(reader, view.snapshot().root.clone(), output).await?;
    fd::fsync(&parent).map_err(io)?;
    Ok(())
}
