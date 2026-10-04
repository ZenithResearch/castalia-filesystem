//! Offline, root-pinned FUSE adapter. Only DiskStore may back callbacks: there
//! is no network runtime, async job queue, wallet or implicit mirror fallback.
use crate::native::DiskStore;
use crate::*;
use fuser::*;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};

pub const MAX_INDEX_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_HANDLES: usize = 4096;
const TTL: Duration = Duration::from_secs(1);
pub type FsResult<T> = Result<T, Errno>;

pub fn errno(error: Error) -> Errno {
    match error {
        Error::NotFound => Errno::ENOENT,
        Error::NotDirectory => Errno::ENOTDIR,
        Error::NotFile => Errno::EISDIR,
        Error::Limit => Errno::EFBIG,
        Error::Invalid(_) => Errno::EINVAL,
        _ => Errno::EIO,
    }
}
fn logical(node: &Node) -> u64 {
    match node {
        Node::File(f) => f.inode,
        Node::Directory(d) => d.inode,
        Node::Snapshot(_) => 0,
    }
}
fn file_type(node: &Node) -> FileType {
    match node {
        Node::Directory(_) => FileType::Directory,
        _ => FileType::RegularFile,
    }
}
struct Indexed {
    node: Node,
    path: String,
    parent: u64,
}
#[derive(Default)]
struct Handles {
    next: u64,
    open: BTreeMap<u64, (u64, bool)>,
}
#[derive(Debug, PartialEq, Eq)]
pub struct Dirent {
    pub inode: u64,
    pub next_offset: u64,
    pub kind: FileType,
    pub name: String,
}

pub struct LocalSnapshotFs {
    store: DiskStore,
    root: ContentId,
    root_logical: u64,
    generation: u64,
    owner: u32,
    gid: u32,
    nodes: BTreeMap<u64, Indexed>,
    index_bytes: usize,
    file_bytes: u64,
    handles: Mutex<Handles>,
    handle_limit: usize,
    reading: AtomicBool,
    stopped: AtomicBool,
}
impl LocalSnapshotFs {
    pub fn open(store: DiskStore, root: ContentId) -> FsResult<Self> {
        Self::with_limits(store, root, MAX_INDEX_BYTES, MAX_HANDLES)
    }
    pub fn with_limits(
        store: DiskStore,
        root: ContentId,
        index_limit: usize,
        handle_limit: usize,
    ) -> FsResult<Self> {
        if index_limit == 0
            || index_limit > MAX_INDEX_BYTES
            || handle_limit == 0
            || handle_limit > MAX_HANDLES
        {
            return Err(Errno::EINVAL);
        }
        futures::executor::block_on(async {
            let view = SnapshotView::open(&store, root).await.map_err(errno)?;
            view.validate_tree().await.map_err(errno)?;
            let root_logical = view.snapshot().root.inode;
            let generation = view.snapshot().generation;
            let kernel_inode = |id| if id == root_logical { 1 } else { id + 1 };
            let mut stack = vec![(view.snapshot().root.clone(), "/".to_string(), 1)];
            let mut nodes = BTreeMap::new();
            let mut index_bytes = 1usize; // root path; charge pending paths too
            let mut file_bytes = 0u64;
            while let Some((reference, path, parent)) = stack.pop() {
                if path.len() > 4096 || nodes.len() >= MAX_TREE_NODES {
                    return Err(Errno::EFBIG);
                }
                let bytes = store
                    .get(reference.manifest, MAX_MANIFEST_BYTES)
                    .await
                    .map_err(errno)?;
                index_bytes = index_bytes.checked_add(bytes.len()).ok_or(Errno::ENOMEM)?;
                if index_bytes > index_limit {
                    return Err(Errno::ENOMEM);
                }
                let node = Manifest::decode(reference.manifest, &bytes)
                    .map_err(errno)?
                    .node;
                if logical(&node) != reference.inode
                    || matches!(node, Node::Snapshot(_))
                    || (file_type(&node) == FileType::Directory)
                        != (reference.kind == NodeKind::Directory)
                {
                    return Err(Errno::EIO);
                }
                let ino = kernel_inode(reference.inode);
                if let Node::Directory(dir) = &node {
                    if stack.len() + dir.entries.len() > MAX_TREE_NODES {
                        return Err(Errno::EFBIG);
                    }
                    for entry in dir.entries.iter().rev() {
                        let child_path = if path == "/" {
                            format!("/{}", entry.name)
                        } else {
                            format!("{path}/{}", entry.name)
                        };
                        if child_path.len() > 4096 {
                            return Err(Errno::EFBIG);
                        }
                        index_bytes = index_bytes
                            .checked_add(child_path.len())
                            .ok_or(Errno::ENOMEM)?;
                        if index_bytes > index_limit {
                            return Err(Errno::ENOMEM);
                        }
                        stack.push((entry.node.clone(), child_path, ino));
                    }
                } else if let Node::File(file) = &node {
                    file_bytes = file_bytes.checked_add(file.size).ok_or(Errno::EFBIG)?;
                }
                if nodes.insert(ino, Indexed { node, path, parent }).is_some() {
                    return Err(Errno::EIO);
                }
            }
            Ok(Self {
                store,
                root,
                root_logical,
                generation,
                owner: rustix::process::geteuid().as_raw(),
                gid: rustix::process::getegid().as_raw(),
                nodes,
                index_bytes,
                file_bytes,
                handles: Mutex::new(Handles::default()),
                handle_limit,
                reading: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
            })
        })
    }
    fn kernel_inode(&self, logical: u64) -> u64 {
        if logical == self.root_logical {
            1
        } else {
            logical + 1
        }
    }
    pub fn root(&self) -> ContentId {
        self.root
    }
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }
    pub fn index_bytes(&self) -> usize {
        self.index_bytes
    }
    pub fn owner(&self) -> u32 {
        self.owner
    }
    fn authorize(&self, uid: u32) -> FsResult<()> {
        if uid != self.owner {
            return Err(Errno::EACCES);
        }
        if self.stopped.load(Ordering::Acquire) {
            return Err(Errno::ENODEV);
        }
        Ok(())
    }
    fn node(&self, ino: u64) -> FsResult<&Indexed> {
        self.nodes.get(&ino).ok_or(Errno::ENOENT)
    }
    pub fn attr(&self, uid: u32, ino: u64) -> FsResult<FileAttr> {
        self.authorize(uid)?;
        let node = &self.node(ino)?.node;
        let (size, modified, perm, nlink) = match node {
            Node::File(f) => (
                f.size,
                f.modified_ms,
                if f.executable { 0o500 } else { 0o400 },
                1,
            ),
            Node::Directory(d) => (
                0,
                d.modified_ms,
                0o500,
                2 + d
                    .entries
                    .iter()
                    .filter(|e| e.node.kind == NodeKind::Directory)
                    .count() as u32,
            ),
            Node::Snapshot(_) => return Err(Errno::EIO),
        };
        let mtime = UNIX_EPOCH
            .checked_add(Duration::from_millis(modified))
            .ok_or(Errno::EINVAL)?;
        Ok(FileAttr {
            ino: INodeNo(ino),
            size,
            blocks: size.div_ceil(512),
            atime: UNIX_EPOCH,
            mtime,
            ctime: mtime,
            crtime: UNIX_EPOCH,
            kind: file_type(node),
            perm,
            nlink,
            uid: self.owner,
            gid: self.gid,
            rdev: 0,
            flags: 0,
            blksize: 4096,
        })
    }
    pub fn lookup_entry(&self, uid: u32, parent: u64, name: &OsStr) -> FsResult<FileAttr> {
        self.authorize(uid)?;
        let indexed = self.node(parent)?;
        let Node::Directory(directory) = &indexed.node else {
            return Err(Errno::ENOTDIR);
        };
        let name = name.to_str().ok_or(Errno::EINVAL)?;
        let ino = match name {
            "." => parent,
            ".." => indexed.parent,
            other => {
                crate::name(other).map_err(errno)?;
                self.kernel_inode(
                    directory
                        .entries
                        .iter()
                        .find(|e| e.name == other)
                        .ok_or(Errno::ENOENT)?
                        .node
                        .inode,
                )
            }
        };
        self.attr(uid, ino)
    }
    pub fn open_handle(&self, uid: u32, ino: u64, flags: i32, directory: bool) -> FsResult<u64> {
        self.authorize(uid)?;
        if flags & libc::O_ACCMODE != libc::O_RDONLY
            || flags & (libc::O_TRUNC | libc::O_APPEND | libc::O_CREAT | libc::O_EXCL) != 0
        {
            return Err(Errno::EROFS);
        }
        if (file_type(&self.node(ino)?.node) == FileType::Directory) != directory {
            return Err(if directory {
                Errno::ENOTDIR
            } else {
                Errno::EISDIR
            });
        }
        let mut handles = self.handles.lock().map_err(|_| Errno::EIO)?;
        self.authorize(uid)?;
        if handles.open.len() >= self.handle_limit {
            return Err(Errno::EMFILE);
        }
        handles.next = handles.next.checked_add(1).ok_or(Errno::EMFILE)?;
        let handle = handles.next;
        handles.open.insert(handle, (ino, directory));
        Ok(handle)
    }
    fn check_handle(&self, ino: u64, handle: u64, directory: bool) -> FsResult<()> {
        let handles = self.handles.lock().map_err(|_| Errno::EIO)?;
        if handles.open.get(&handle) != Some(&(ino, directory)) {
            return Err(Errno::EBADF);
        }
        Ok(())
    }
    pub fn close_handle(&self, uid: u32, ino: u64, handle: u64, directory: bool) -> FsResult<()> {
        self.authorize(uid)?;
        let mut handles = self.handles.lock().map_err(|_| Errno::EIO)?;
        if handles.open.get(&handle) != Some(&(ino, directory)) {
            return Err(Errno::EBADF);
        }
        handles.open.remove(&handle);
        Ok(())
    }
    pub fn read_file(
        &self,
        uid: u32,
        ino: u64,
        handle: u64,
        offset: u64,
        length: usize,
    ) -> FsResult<Vec<u8>> {
        self.authorize(uid)?;
        self.check_handle(ino, handle, false)?;
        if length > MAX_READ_BYTES {
            return Err(Errno::EFBIG);
        }
        if self
            .reading
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(Errno::EAGAIN);
        }
        struct Reading<'a>(&'a AtomicBool);
        impl Drop for Reading<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _guard = Reading(&self.reading);
        let bytes = futures::executor::block_on(async {
            let view = SnapshotView::open(&self.store, self.root).await?;
            view.read_range(
                &self.node(ino).map_err(|_| Error::NotFound)?.path,
                offset,
                length,
            )
            .await
        })
        .map_err(errno)?;
        self.authorize(uid)?;
        Ok(bytes)
    }
    pub fn directory_entries(
        &self,
        uid: u32,
        ino: u64,
        handle: u64,
        offset: u64,
        limit: usize,
    ) -> FsResult<Vec<Dirent>> {
        self.authorize(uid)?;
        self.check_handle(ino, handle, true)?;
        if limit > MAX_ENTRIES + 2 {
            return Err(Errno::EINVAL);
        }
        let indexed = self.node(ino)?;
        let Node::Directory(directory) = &indexed.node else {
            return Err(Errno::ENOTDIR);
        };
        if offset >= directory.entries.len() as u64 + 2 {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        for index in (offset as usize..directory.entries.len() + 2).take(limit) {
            let (inode, kind, name) = match index {
                0 => (ino, FileType::Directory, ".".to_string()),
                1 => (indexed.parent, FileType::Directory, "..".to_string()),
                n => {
                    let entry = &directory.entries[n - 2];
                    (
                        self.kernel_inode(entry.node.inode),
                        if entry.node.kind == NodeKind::Directory {
                            FileType::Directory
                        } else {
                            FileType::RegularFile
                        },
                        entry.name.clone(),
                    )
                }
            };
            entries.push(Dirent {
                inode,
                kind,
                name,
                next_offset: (index + 1) as u64,
            });
        }
        Ok(entries)
    }
    pub fn refuse_mutation(&self, uid: u32) -> Errno {
        self.authorize(uid).err().unwrap_or(Errno::EROFS)
    }
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(mut handles) = self.handles.lock() {
            handles.open.clear();
        }
    }
    pub fn check_mountpoint(&self, path: &Path) -> FsResult<PathBuf> {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::symlink_metadata(path).map_err(|_| Errno::ENOENT)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != self.owner
            || metadata.mode() & 0o077 != 0
        {
            return Err(Errno::EACCES);
        }
        let path = std::fs::canonicalize(path).map_err(|_| Errno::EINVAL)?;
        if path.starts_with(self.store.path()) || self.store.path().starts_with(&path) {
            return Err(Errno::EINVAL);
        }
        if std::fs::read_dir(&path)
            .map_err(|_| Errno::EACCES)?
            .next()
            .is_some()
        {
            return Err(Errno::ENOTEMPTY);
        }
        Ok(path)
    }
}
pub fn mount_config() -> Config {
    let mut config = Config::default();
    config.acl = SessionACL::Owner;
    config.n_threads = Some(1);
    config.mount_options = vec![
        MountOption::RO,
        MountOption::DefaultPermissions,
        MountOption::NoDev,
        MountOption::NoSuid,
        MountOption::NoExec,
        MountOption::NoAtime,
        MountOption::FSName("castalia-snapshot".into()),
    ];
    config
}

/// Explicit native side effect. Test builds refuse before any backend call.
pub fn mount_local(fs: LocalSnapshotFs, mountpoint: &Path) -> Result<(), Error> {
    if cfg!(feature = "fuse-check") {
        return Err(Error::Invalid(
            "fuse-check build cannot mount; rebuild with --features fuse and an approved native backend",
        ));
    }
    let mountpoint = fs
        .check_mountpoint(mountpoint)
        .map_err(|e| Error::Provider(format!("FUSE: {e:?}")))?;
    fuser::mount(fs, mountpoint, &mount_config())
        .map_err(|e| Error::Provider(format!("FUSE mount: {e}")))
}

macro_rules! readonly {
    ($name:ident($($arg:ident : $ty:ty),*) -> $reply:ty) => {
        fn $name(&self, req: &Request, $($arg: $ty,)* reply: $reply) {
            $(let _ = $arg;)*
            reply.error(self.refuse_mutation(req.uid()));
        }
    };
}
impl Filesystem for LocalSnapshotFs {
    fn init(&mut self, _req: &Request, config: &mut KernelConfig) -> std::io::Result<()> {
        config
            .set_max_background(16)
            .map_err(|_| std::io::Error::other("FUSE background limit"))?;
        // fuser rejects zero. One byte caps readahead; if the kernel advertised
        // zero, retain its already-disabled default rather than fail init.
        let _ = config.set_max_readahead(1);
        Ok(())
    }
    fn destroy(&mut self) {
        self.shutdown();
    }
    fn lookup(&self, req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        match self.lookup_entry(req.uid(), parent.0, name) {
            Ok(attr) => reply.entry(&TTL, &attr, Generation(self.generation)),
            Err(e) => reply.error(e),
        }
    }
    fn getattr(&self, req: &Request, ino: INodeNo, fh: Option<FileHandle>, reply: ReplyAttr) {
        let result = self.attr(req.uid(), ino.0).and_then(|attr| {
            if let Some(handle) = fh {
                self.check_handle(ino.0, handle.0, attr.kind == FileType::Directory)?;
            }
            Ok(attr)
        });
        match result {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(e) => reply.error(e),
        }
    }
    fn open(&self, req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        match self.open_handle(req.uid(), ino.0, flags.0, false) {
            Ok(h) => reply.opened(FileHandle(h), FopenFlags::FOPEN_DIRECT_IO),
            Err(e) => reply.error(e),
        }
    }
    fn opendir(&self, req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        match self.open_handle(req.uid(), ino.0, flags.0, true) {
            Ok(h) => reply.opened(FileHandle(h), FopenFlags::empty()),
            Err(e) => reply.error(e),
        }
    }
    fn read(
        &self,
        req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyData,
    ) {
        match self.read_file(req.uid(), ino.0, fh.0, offset, size as usize) {
            Ok(bytes) => reply.data(&bytes),
            Err(e) => reply.error(e),
        }
    }
    fn readdir(
        &self,
        req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        mut reply: ReplyDirectory,
    ) {
        match self.directory_entries(req.uid(), ino.0, fh.0, offset, MAX_ENTRIES + 2) {
            Ok(entries) => {
                for entry in entries {
                    if reply.add(
                        INodeNo(entry.inode),
                        entry.next_offset,
                        entry.kind,
                        entry.name,
                    ) {
                        break;
                    }
                }
                reply.ok();
            }
            Err(e) => reply.error(e),
        }
    }
    fn release(
        &self,
        req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        match self.close_handle(req.uid(), ino.0, fh.0, false) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }
    fn releasedir(
        &self,
        req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        reply: ReplyEmpty,
    ) {
        match self.close_handle(req.uid(), ino.0, fh.0, true) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }
    fn flush(
        &self,
        req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        _lock_owner: LockOwner,
        reply: ReplyEmpty,
    ) {
        match self
            .authorize(req.uid())
            .and_then(|_| self.check_handle(ino.0, fh.0, false))
        {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }
    fn fsync(
        &self,
        req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        _datasync: bool,
        reply: ReplyEmpty,
    ) {
        match self
            .authorize(req.uid())
            .and_then(|_| self.check_handle(ino.0, fh.0, false))
        {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }
    fn fsyncdir(
        &self,
        req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        _datasync: bool,
        reply: ReplyEmpty,
    ) {
        match self
            .authorize(req.uid())
            .and_then(|_| self.check_handle(ino.0, fh.0, true))
        {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }
    fn statfs(&self, req: &Request, ino: INodeNo, reply: ReplyStatfs) {
        match self.attr(req.uid(), ino.0) {
            Ok(_) => reply.statfs(
                self.file_bytes.div_ceil(4096),
                0,
                0,
                self.nodes.len() as u64,
                0,
                4096,
                255,
                4096,
            ),
            Err(e) => reply.error(e),
        }
    }
    fn access(&self, req: &Request, ino: INodeNo, mask: AccessFlags, reply: ReplyEmpty) {
        let result = self.attr(req.uid(), ino.0).and_then(|attr| {
            if mask.bits() & libc::W_OK != 0 {
                return Err(Errno::EROFS);
            }
            if mask.bits() & libc::X_OK != 0
                && (attr.kind != FileType::Directory || attr.perm & 0o100 == 0)
            {
                return Err(Errno::EACCES);
            }
            Ok(())
        });
        match result {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }
    readonly!(setattr(ino: INodeNo, mode: Option<u32>, uid: Option<u32>, gid: Option<u32>, size: Option<u64>, atime: Option<TimeOrNow>, mtime: Option<TimeOrNow>, ctime: Option<std::time::SystemTime>, fh: Option<FileHandle>, crtime: Option<std::time::SystemTime>, chgtime: Option<std::time::SystemTime>, bkuptime: Option<std::time::SystemTime>, flags: Option<BsdFileFlags>) -> ReplyAttr);
    readonly!(mknod(parent: INodeNo, name: &OsStr, mode: u32, umask: u32, rdev: u32) -> ReplyEntry);
    readonly!(mkdir(parent: INodeNo, name: &OsStr, mode: u32, umask: u32) -> ReplyEntry);
    readonly!(unlink(parent: INodeNo, name: &OsStr) -> ReplyEmpty);
    readonly!(rmdir(parent: INodeNo, name: &OsStr) -> ReplyEmpty);
    readonly!(symlink(parent: INodeNo, link_name: &OsStr, target: &Path) -> ReplyEntry);
    readonly!(rename(parent: INodeNo, name: &OsStr, newparent: INodeNo, newname: &OsStr, flags: RenameFlags) -> ReplyEmpty);
    readonly!(link(ino: INodeNo, newparent: INodeNo, newname: &OsStr) -> ReplyEntry);
    readonly!(create(parent: INodeNo, name: &OsStr, mode: u32, umask: u32, flags: i32) -> ReplyCreate);
    readonly!(write(ino: INodeNo, fh: FileHandle, offset: u64, data: &[u8], write_flags: WriteFlags, flags: OpenFlags, lock_owner: Option<LockOwner>) -> ReplyWrite);
    readonly!(setxattr(ino: INodeNo, name: &OsStr, value: &[u8], flags: i32, position: u32) -> ReplyEmpty);
    readonly!(removexattr(ino: INodeNo, name: &OsStr) -> ReplyEmpty);
    readonly!(fallocate(ino: INodeNo, fh: FileHandle, offset: u64, length: u64, mode: i32) -> ReplyEmpty);
    readonly!(copy_file_range(ino_in: INodeNo, fh_in: FileHandle, offset_in: u64, ino_out: INodeNo, fh_out: FileHandle, offset_out: u64, len: u64, flags: CopyFileRangeFlags) -> ReplyWrite);
}
