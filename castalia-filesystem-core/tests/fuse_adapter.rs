#![cfg(all(feature = "fuse", unix, not(target_arch = "wasm32")))]
use castalia_filesystem_core::fuse::*;
use castalia_filesystem_core::native::*;
use castalia_filesystem_core::*;
use fuser::{Errno, FileType, MountOption, SessionACL};
use futures::executor::block_on;
use std::ffi::OsStr;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;

fn fixture() -> (tempfile::TempDir, ContentId, Vec<u8>) {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::create_dir(source.join("sub")).unwrap();
    let bytes: Vec<_> = (0..MAX_CHUNK_BYTES + 41).map(|i| (i % 251) as u8).collect();
    std::fs::write(source.join("sub/large"), &bytes).unwrap();
    std::fs::write(source.join("empty"), []).unwrap();
    let store = DiskStore::open(&tmp.path().join("store")).unwrap();
    let id = block_on(import_directory(
        &store,
        &source,
        ContentId::for_bytes(b"test"),
    ))
    .unwrap();
    (tmp, id, bytes)
}
fn open(tmp: &Path, id: ContentId) -> LocalSnapshotFs {
    LocalSnapshotFs::open(DiskStore::open(&tmp.join("store")).unwrap(), id).unwrap()
}
fn lookup(fs: &LocalSnapshotFs, parent: u64, name: &str) -> u64 {
    fs.lookup_entry(fs.owner(), parent, OsStr::new(name))
        .unwrap()
        .ino
        .0
}
#[test]
fn attrs_lookup_permissions_and_bounded_cross_chunk_reads() {
    let (tmp, id, bytes) = fixture();
    let fs = open(tmp.path(), id);
    let uid = fs.owner();
    assert_eq!(fs.root(), id);
    assert_eq!(fs.node_count(), 4);
    let root = fs.attr(uid, 1).unwrap();
    assert_eq!(root.kind, FileType::Directory);
    assert_eq!(root.perm, 0o500);
    assert_eq!(root.nlink, 3);
    let sub = lookup(&fs, 1, "sub");
    let file = lookup(&fs, sub, "large");
    let attr = fs.attr(uid, file).unwrap();
    assert_eq!(attr.size, bytes.len() as u64);
    assert_eq!(attr.perm, 0o400);
    assert_eq!(attr.uid, uid);
    assert_eq!(lookup(&fs, sub, ".."), 1);
    assert_eq!(lookup(&fs, 1, ".."), 1);
    assert_eq!(
        fs.attr(uid.wrapping_add(1), file).unwrap_err(),
        Errno::EACCES
    );
    assert_eq!(
        fs.lookup_entry(uid, file, OsStr::new("x")).unwrap_err(),
        Errno::ENOTDIR
    );
    assert_eq!(
        fs.lookup_entry(uid, 1, OsStr::new("sub/large"))
            .unwrap_err(),
        Errno::EINVAL
    );
    assert_eq!(
        fs.lookup_entry(uid, 1, OsStr::new("missing")).unwrap_err(),
        Errno::ENOENT
    );
    let handle = fs.open_handle(uid, file, libc::O_RDONLY, false).unwrap();
    for (offset, length) in [
        (0, 0),
        (0, 20),
        (MAX_CHUNK_BYTES - 7, 30),
        (bytes.len() - 2, 10),
        (bytes.len(), 10),
    ] {
        assert_eq!(
            fs.read_file(uid, file, handle, offset as u64, length)
                .unwrap(),
            bytes[offset..(offset + length).min(bytes.len())]
        );
    }
    assert!(
        fs.read_file(uid, file, handle, u64::MAX, 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fs.read_file(uid, file, handle, 0, MAX_READ_BYTES + 1),
        Err(Errno::EFBIG)
    );
    let empty = lookup(&fs, 1, "empty");
    let empty_handle = fs.open_handle(uid, empty, libc::O_RDONLY, false).unwrap();
    assert!(
        fs.read_file(uid, empty, empty_handle, 0, 20)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn readdir_offsets_handle_types_and_releases() {
    let (tmp, id, _) = fixture();
    let fs = open(tmp.path(), id);
    let uid = fs.owner();
    let h = fs.open_handle(uid, 1, libc::O_RDONLY, true).unwrap();
    let entries = fs.directory_entries(uid, 1, h, 0, 10).unwrap();
    assert_eq!(
        entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
        [".", "..", "empty", "sub"]
    );
    let mut offset = 0;
    let mut resumed = Vec::new();
    loop {
        let page = fs.directory_entries(uid, 1, h, offset, 1).unwrap();
        if page.is_empty() {
            break;
        }
        offset = page[0].next_offset;
        resumed.extend(page);
    }
    assert_eq!(resumed, entries);
    assert!(
        fs.directory_entries(uid, 1, h, u64::MAX, 1)
            .unwrap()
            .is_empty()
    );
    assert_eq!(fs.read_file(uid, 1, h, 0, 1), Err(Errno::EBADF));
    assert_eq!(fs.close_handle(uid, 1, h, false), Err(Errno::EBADF));
    fs.close_handle(uid, 1, h, true).unwrap();
    assert_eq!(fs.directory_entries(uid, 1, h, 0, 1), Err(Errno::EBADF));
    let next = fs.open_handle(uid, 1, libc::O_RDONLY, true).unwrap();
    assert_ne!(next, h);
}
#[test]
fn limits_mutation_refusal_shutdown_and_mount_options() {
    let (tmp, id, _) = fixture();
    let store = || DiskStore::open(&tmp.path().join("store")).unwrap();
    assert_eq!(
        LocalSnapshotFs::with_limits(store(), id, 1, 1).err(),
        Some(Errno::ENOMEM)
    );
    assert_eq!(
        LocalSnapshotFs::with_limits(store(), id, MAX_INDEX_BYTES, 0).err(),
        Some(Errno::EINVAL)
    );
    let fs = LocalSnapshotFs::with_limits(store(), id, MAX_INDEX_BYTES, 1).unwrap();
    let uid = fs.owner();
    let file = lookup(&fs, 1, "empty");
    for flags in [
        libc::O_WRONLY,
        libc::O_RDWR,
        libc::O_RDONLY | libc::O_TRUNC,
        libc::O_APPEND,
        libc::O_CREAT,
        libc::O_EXCL,
    ] {
        assert_eq!(fs.open_handle(uid, file, flags, false), Err(Errno::EROFS));
    }
    assert_eq!(fs.refuse_mutation(uid), Errno::EROFS);
    assert_eq!(fs.refuse_mutation(uid.wrapping_add(1)), Errno::EACCES);
    let handle = fs.open_handle(uid, file, 0, false).unwrap();
    assert_eq!(fs.open_handle(uid, file, 0, false), Err(Errno::EMFILE));
    assert_eq!(
        fs.read_file(uid, file + 100, handle, 0, 1),
        Err(Errno::EBADF)
    );
    fs.close_handle(uid, file, handle, false).unwrap();
    fs.open_handle(uid, file, 0, false).unwrap();
    fs.shutdown();
    fs.shutdown();
    assert_eq!(fs.attr(uid, 1).unwrap_err(), Errno::ENODEV);
    assert_eq!(fs.refuse_mutation(uid), Errno::ENODEV);
    let config = mount_config();
    assert_eq!(config.acl, SessionACL::Owner);
    assert_eq!(config.n_threads, Some(1));
    assert!(config.mount_options.contains(&MountOption::RO));
    assert!(config.mount_options.contains(&MountOption::NoExec));
    assert!(!config.mount_options.contains(&MountOption::AutoUnmount));
    assert!(!config.mount_options.contains(&MountOption::RW));
}
#[test]
fn chunk_loss_and_corruption_are_io_errors_not_stale_bytes() {
    let (tmp, id, bytes) = fixture();
    let fs = open(tmp.path(), id);
    let uid = fs.owner();
    let file = lookup(&fs, lookup(&fs, 1, "sub"), "large");
    let h = fs.open_handle(uid, file, 0, false).unwrap();
    let chunk = ContentId::for_bytes(&bytes[..MAX_CHUNK_BYTES]);
    let path = tmp.path().join("store").join(String::from(chunk));
    std::fs::write(&path, b"corrupt").unwrap();
    assert_eq!(fs.read_file(uid, file, h, 0, 20), Err(Errno::EIO));
    std::fs::remove_file(&path).unwrap();
    assert_eq!(fs.read_file(uid, file, h, 0, 20), Err(Errno::EIO));
    block_on(
        DiskStore::open(&tmp.path().join("store"))
            .unwrap()
            .put(&bytes[..MAX_CHUNK_BYTES]),
    )
    .unwrap();
    assert_eq!(fs.read_file(uid, file, h, 0, 20).unwrap(), bytes[..20]);
}
#[test]
fn independent_roots_remain_pinned() {
    let (tmp, old, bytes) = fixture();
    std::fs::write(tmp.path().join("source/sub/large"), b"new version").unwrap();
    let store = DiskStore::open(&tmp.path().join("store")).unwrap();
    let new = block_on(import_directory(
        &store,
        &tmp.path().join("source"),
        ContentId::for_bytes(b"test"),
    ))
    .unwrap();
    assert_ne!(old, new);
    for (root, expected) in [(old, &bytes[..20]), (new, b"new version".as_slice())] {
        let fs = open(tmp.path(), root);
        let uid = fs.owner();
        let file = lookup(&fs, lookup(&fs, 1, "sub"), "large");
        let h = fs.open_handle(uid, file, 0, false).unwrap();
        assert_eq!(fs.read_file(uid, file, h, 0, 20).unwrap(), expected);
    }
}
#[test]
fn logical_root_is_remapped_without_colliding_with_child_inode_one() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DiskStore::open(&tmp.path().join("store")).unwrap();
    let root = block_on(async {
        let file = store
            .put(
                &Manifest::new(Node::File(File {
                    inode: 1,
                    modified_ms: 0,
                    executable: false,
                    size: 0,
                    chunks: vec![],
                }))
                .encode()
                .unwrap(),
            )
            .await
            .unwrap();
        let directory = store
            .put(
                &Manifest::new(Node::Directory(
                    Directory::new(
                        9,
                        0,
                        vec![Entry {
                            name: "child".into(),
                            node: NodeRef {
                                inode: 1,
                                kind: NodeKind::File,
                                manifest: file,
                            },
                        }],
                    )
                    .unwrap(),
                ))
                .encode()
                .unwrap(),
            )
            .await
            .unwrap();
        store
            .put(
                &Manifest::new(Node::Snapshot(Snapshot {
                    namespace: ContentId::for_bytes(b"ns"),
                    generation: 0,
                    previous: None,
                    root: NodeRef {
                        inode: 9,
                        kind: NodeKind::Directory,
                        manifest: directory,
                    },
                }))
                .encode()
                .unwrap(),
            )
            .await
            .unwrap()
    });
    let fs = LocalSnapshotFs::open(store, root).unwrap();
    assert_eq!(lookup(&fs, 1, "child"), 2);
    assert_eq!(fs.attr(fs.owner(), 1).unwrap().kind, FileType::Directory);
}
#[test]
fn mountpoint_preflight_is_owner_private_empty_and_disjoint() {
    let (tmp, id, _) = fixture();
    let fs = open(tmp.path(), id);
    let path = tmp.path().join("mount");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        fs.check_mountpoint(&path).unwrap(),
        std::fs::canonicalize(&path).unwrap()
    );
    let link = tmp.path().join("link");
    symlink(&path, &link).unwrap();
    assert_eq!(fs.check_mountpoint(&link), Err(Errno::EACCES));
    std::fs::write(path.join("existing"), b"keep").unwrap();
    assert_eq!(fs.check_mountpoint(&path), Err(Errno::ENOTEMPTY));
    assert_eq!(std::fs::read(path.join("existing")).unwrap(), b"keep");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(fs.check_mountpoint(&path), Err(Errno::EACCES));
    assert_eq!(
        fs.check_mountpoint(&tmp.path().join("store")),
        Err(Errno::EINVAL)
    );
}
#[test]
fn cli_check_only_does_not_mount_and_check_build_cannot_mount() {
    let (tmp, id, _) = fixture();
    let path = tmp.path().join("mount");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let run = |check_only: bool| {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_castalia-fs"));
        command
            .arg("--store")
            .arg(tmp.path().join("store"))
            .arg("mount")
            .arg(String::from(id))
            .arg(&path);
        if check_only {
            command.arg("--check-only");
        }
        command.output().unwrap()
    };
    let result = run(true);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("no mount performed"));
    #[cfg(feature = "fuse-check")]
    {
        let result = run(false);
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("fuse-check build cannot mount"));
    }
    assert!(std::fs::read_dir(&path).unwrap().next().is_none());
}
