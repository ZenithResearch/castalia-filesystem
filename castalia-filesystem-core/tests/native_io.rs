#![cfg(all(unix, not(target_arch = "wasm32")))]
use castalia_filesystem_core::native::*;
use castalia_filesystem_core::transfer::*;
use castalia_filesystem_core::*;
use futures::executor::block_on;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;

fn source(path: &Path) {
    std::fs::create_dir(path).unwrap();
    std::fs::create_dir(path.join("writer")).unwrap();
    std::fs::create_dir(path.join("empty-dir")).unwrap();
    std::fs::write(path.join("writer/post.md"), b"post").unwrap();
    std::fs::write(path.join("zero"), []).unwrap();
    std::fs::write(path.join("large"), vec![42; MAX_CHUNK_BYTES + 17]).unwrap();
}

#[test]
fn cli_rejects_symlink_source_and_store_nested_in_source() {
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("input");
    std::fs::create_dir(&input).unwrap();
    let link = tmp.path().join("link");
    symlink(&input, &link).unwrap();
    let namespace = String::from(ContentId::for_bytes(b"test"));
    for (source, store) in [
        (&link, tmp.path().join("store")),
        (&input, input.join("nested")),
    ] {
        let result = std::process::Command::new(env!("CARGO_BIN_EXE_castalia-fs"))
            .arg("--store")
            .arg(store)
            .arg("import")
            .arg(source)
            .arg("--namespace")
            .arg(&namespace)
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&result.stderr).contains("panicked"));
    }
}

#[test]
fn cli_import_verify_read_export_roundtrip() {
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("input");
    std::fs::create_dir(&input).unwrap();
    std::fs::write(input.join("post.md"), b"public test post").unwrap();
    let store = tmp.path().join("store");
    let run = |args: &[&str]| {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_castalia-fs"))
            .arg("--store")
            .arg(&store)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    };
    let namespace = String::from(ContentId::for_bytes(b"test"));
    let imported = run(&["import", input.to_str().unwrap(), "--namespace", &namespace]);
    let id = imported.trim();
    ContentId::try_from(id.to_owned()).unwrap();
    assert!(run(&["verify", id]).contains("verified 2 nodes"));
    assert!(run(&["list", id]).contains("post.md"));
    assert_eq!(run(&["read", id, "/post.md"]), "public test post");
    let output = tmp.path().join("output");
    run(&["export", id, output.to_str().unwrap()]);
    assert_eq!(
        std::fs::read(output.join("post.md")).unwrap(),
        b"public test post"
    );
}
#[test]
fn durable_reopen_import_export_and_metadata_roundtrip() {
    block_on(async {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("input");
        source(&input);
        let path = tmp.path().join("store");
        let store = DiskStore::open(&path).unwrap();
        let id = import_directory(&store, &input, ContentId::for_bytes(b"ns"))
            .await
            .unwrap();
        drop(store);
        let store = DiskStore::open(&path).unwrap();
        let view = SnapshotView::open(&store, id).await.unwrap();
        assert_eq!(view.validate_tree().await.unwrap(), 6);
        let output = tmp.path().join("export");
        export_directory(&store, id, &output).await.unwrap();
        for path in ["writer/post.md", "zero", "large"] {
            assert_eq!(
                std::fs::read(input.join(path)).unwrap(),
                std::fs::read(output.join(path)).unwrap()
            );
            let a = std::fs::metadata(input.join(path))
                .unwrap()
                .modified()
                .unwrap();
            let b = std::fs::metadata(output.join(path))
                .unwrap()
                .modified()
                .unwrap();
            assert_eq!(
                a.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
                b.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
            );
        }
        assert!(output.join("empty-dir").is_dir());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o077,
            0
        );
        assert!(export_directory(&store, id, &output).await.is_err());
    });
}

#[test]
fn private_store_refuses_symlinks_corrupt_records_and_oversize() {
    block_on(async {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("store");
        let store = DiskStore::open(&path).unwrap();
        let id = store.put(b"abc").await.unwrap();
        assert_eq!(store.get(id, 2).await, Err(Error::Limit));
        assert_eq!(
            store.put(&vec![0; MAX_CHUNK_BYTES + 1]).await,
            Err(Error::Limit)
        );
        std::fs::write(path.join(String::from(id)), b"bad").unwrap();
        assert_eq!(store.get(id, 3).await, Err(Error::Integrity));
        assert_eq!(store.put(b"abc").await, Err(Error::Integrity));
        let outside = tmp.path().join("outside");
        std::fs::write(&outside, b"secret").unwrap();
        let wanted = ContentId::for_bytes(b"secret");
        symlink(&outside, path.join(String::from(wanted))).unwrap();
        assert!(store.get(wanted, 10).await.is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"secret");
        let link = tmp.path().join("link");
        symlink(&path, &link).unwrap();
        assert!(DiskStore::open(&link).is_err());
    });
}

#[test]
fn source_symlink_and_special_entries_are_refused() {
    block_on(async {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("input");
        std::fs::create_dir(&input).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::write(&outside, b"private").unwrap();
        symlink(&outside, input.join("leak")).unwrap();
        let store = DiskStore::open(&tmp.path().join("store")).unwrap();
        assert!(
            import_directory(&store, &input, ContentId::for_bytes(b"ns"))
                .await
                .is_err()
        );
        assert!(
            import_directory(&store, &input.join("leak"), ContentId::for_bytes(b"ns"))
                .await
                .is_err()
        );
    });
}

#[test]
fn source_mutation_during_import_is_refused() {
    block_on(async {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("input");
        std::fs::create_dir(&input).unwrap();
        let file = input.join("a");
        std::fs::write(&file, b"before").unwrap();
        struct Mutating<'a> {
            store: &'a DiskStore,
            file: &'a Path,
        }
        impl ObjectWriter for Mutating<'_> {
            async fn put(&self, bytes: &[u8]) -> Result<ContentId, Error> {
                std::fs::write(self.file, b"after and different").unwrap();
                self.store.put(bytes).await
            }
        }
        let store = DiskStore::open(&tmp.path().join("store")).unwrap();
        assert!(
            import_directory(
                &Mutating {
                    store: &store,
                    file: &file
                },
                &input,
                ContentId::for_bytes(b"ns")
            )
            .await
            .is_err()
        );
    });
}

#[test]
fn interrupted_temporary_record_is_ignored_and_idempotent_writes_work() {
    block_on(async {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("store");
        let store = DiskStore::open(&path).unwrap();
        std::fs::write(path.join(".tmp-interrupted"), b"partial").unwrap();
        let id = store.put(b"complete").await.unwrap();
        assert_eq!(store.put(b"complete").await.unwrap(), id);
        drop(store);
        assert_eq!(
            DiskStore::open(&path).unwrap().get(id, 100).await.unwrap(),
            b"complete"
        );
    });
}

#[test]
fn replication_checks_budget_and_destination_bytes() {
    block_on(async {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("input");
        source(&input);
        let a = DiskStore::open(&tmp.path().join("a")).unwrap();
        let b = DiskStore::open(&tmp.path().join("b")).unwrap();
        let id = import_directory(&a, &input, ContentId::for_bytes(b"ns"))
            .await
            .unwrap();
        assert_eq!(
            copy_snapshot(
                &a,
                &b,
                id,
                TransferBudget {
                    max_objects: 1,
                    max_bytes: 10
                }
            )
            .await,
            Err(Error::Limit)
        );
        assert_eq!(b.get(id, MAX_MANIFEST_BYTES).await, Err(Error::Unavailable));
        let report = copy_snapshot(
            &a,
            &b,
            id,
            TransferBudget {
                max_objects: 100,
                max_bytes: 10 * MAX_CHUNK_BYTES as u64,
            },
        )
        .await
        .unwrap();
        assert!(report.objects > 7);
        assert!(report.bytes > MAX_CHUNK_BYTES as u64);
        export_directory(&b, id, &tmp.path().join("export"))
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(input.join("large")).unwrap(),
            std::fs::read(tmp.path().join("export/large")).unwrap()
        );
    });
}

#[test]
fn replication_rejects_hash_valid_chunk_with_wrong_declared_size() {
    block_on(async {
        let tmp = tempfile::tempdir().unwrap();
        let a = DiskStore::open(&tmp.path().join("a")).unwrap();
        let b = DiskStore::open(&tmp.path().join("b")).unwrap();
        let chunk = a.put(b"abc").await.unwrap();
        let file = a
            .put(
                &Manifest::new(Node::File(File {
                    inode: 2,
                    modified_ms: 0,
                    executable: false,
                    size: 5,
                    chunks: vec![Chunk {
                        content: chunk,
                        size: 5,
                    }],
                }))
                .encode()
                .unwrap(),
            )
            .await
            .unwrap();
        let directory = a
            .put(
                &Manifest::new(Node::Directory(
                    Directory::new(
                        1,
                        0,
                        vec![Entry {
                            name: "file".into(),
                            node: NodeRef {
                                inode: 2,
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
        let snapshot = a
            .put(
                &Manifest::new(Node::Snapshot(Snapshot {
                    namespace: ContentId::for_bytes(b"test"),
                    generation: 0,
                    previous: None,
                    root: NodeRef {
                        inode: 1,
                        kind: NodeKind::Directory,
                        manifest: directory,
                    },
                }))
                .encode()
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            copy_snapshot(
                &a,
                &b,
                snapshot,
                TransferBudget {
                    max_objects: 20,
                    max_bytes: 10000
                }
            )
            .await,
            Err(Error::Integrity)
        );
        assert_eq!(
            b.get(snapshot, MAX_MANIFEST_BYTES).await,
            Err(Error::Unavailable)
        );
    });
}

#[test]
fn fallback_requires_explicit_scope_and_never_masks_corruption() {
    block_on(async {
        struct Fail(Error);
        impl ObjectReader for Fail {
            async fn get(&self, _: ContentId, _: usize) -> Result<Vec<u8>, Error> {
                Err(self.0.clone())
            }
        }
        let tmp = tempfile::tempdir().unwrap();
        let mirror = DiskStore::open(&tmp.path().join("mirror")).unwrap();
        let id = mirror.put(b"verified").await.unwrap();
        let empty = std::collections::BTreeSet::new();
        let allowed = std::collections::BTreeSet::from([id]);
        let unavailable = Fail(Error::Unavailable);
        let denied = VerifiedFallback {
            primary: &unavailable,
            mirror: &mirror,
            allowed_mirror_ids: &empty,
        };
        assert_eq!(denied.get(id, 100).await, Err(Error::Unavailable));
        let enabled = VerifiedFallback {
            primary: &unavailable,
            mirror: &mirror,
            allowed_mirror_ids: &allowed,
        };
        assert_eq!(enabled.get(id, 100).await.unwrap(), b"verified");
        let bad = Fail(Error::Integrity);
        let fail = VerifiedFallback {
            primary: &bad,
            mirror: &mirror,
            allowed_mirror_ids: &allowed,
        };
        assert_eq!(fail.get(id, 100).await, Err(Error::Integrity));
        for error in [
            Error::Provider("opaque provider failure".into()),
            Error::Invalid("authorization"),
            Error::Limit,
        ] {
            let primary = Fail(error.clone());
            let fail = VerifiedFallback {
                primary: &primary,
                mirror: &mirror,
                allowed_mirror_ids: &allowed,
            };
            assert_eq!(fail.get(id, 100).await, Err(error));
        }
    });
}
