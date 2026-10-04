//! Driver-free walk through the operation layer used by FUSE callbacks.
//! Explicit local source comparison; never mounts or fetches remote data.
#[cfg(all(feature = "fuse", unix, not(target_arch = "wasm32")))]
fn main() {
    use castalia_filesystem_core::fuse::LocalSnapshotFs;
    use castalia_filesystem_core::native::DiskStore;
    use castalia_filesystem_core::{ContentId, MAX_CHUNK_BYTES};
    use fuser::FileType;
    use std::io::Read;
    use std::path::PathBuf;
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert_eq!(args.len(), 3, "usage: fuse_fixture STORE SNAPSHOT SOURCE");
    let fs = LocalSnapshotFs::open(
        DiskStore::open(&PathBuf::from(&args[0])).unwrap(),
        ContentId::try_from(args[1].clone()).unwrap(),
    )
    .unwrap();
    let uid = fs.owner();
    let source = PathBuf::from(&args[2]);
    let mut stack = vec![(1, source)];
    let mut files = 0;
    let mut verified_bytes = 0u64;
    while let Some((ino, source)) = stack.pop() {
        let attr = fs.attr(uid, ino).unwrap();
        if attr.kind == FileType::Directory {
            assert!(std::fs::symlink_metadata(&source).unwrap().is_dir());
            let handle = fs.open_handle(uid, ino, 0, true).unwrap();
            let mut offset = 0;
            loop {
                let entries = fs.directory_entries(uid, ino, handle, offset, 16).unwrap();
                if entries.is_empty() {
                    break;
                }
                for entry in entries {
                    offset = entry.next_offset;
                    if entry.name != "." && entry.name != ".." {
                        stack.push((entry.inode, source.join(entry.name)));
                    }
                }
            }
            fs.close_handle(uid, ino, handle, true).unwrap();
        } else {
            let mut file = std::fs::File::open(source).unwrap();
            assert_eq!(file.metadata().unwrap().len(), attr.size);
            let handle = fs.open_handle(uid, ino, 0, false).unwrap();
            let mut offset = 0;
            loop {
                let bytes = fs
                    .read_file(uid, ino, handle, offset, MAX_CHUNK_BYTES)
                    .unwrap();
                if bytes.is_empty() {
                    break;
                }
                let mut expected = vec![0; bytes.len()];
                file.read_exact(&mut expected).unwrap();
                assert!(bytes == expected, "fixture byte mismatch");
                offset += bytes.len() as u64;
            }
            assert_eq!(offset, attr.size);
            fs.close_handle(uid, ino, handle, false).unwrap();
            files += 1;
            verified_bytes += offset;
        }
    }
    println!(
        "verified {files} files, {verified_bytes} bytes through FUSE operation layer; no mount performed"
    );
}
#[cfg(not(all(feature = "fuse", unix, not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("requires native Unix and --features fuse or fuse-check");
}
