use castalia_filesystem_core::{
    Chunk, ContentId, Error, ObjectReader, ObjectWriter, SnapshotView,
    builder::SnapshotBuilder,
    revisions::{StagedFile, create_directory, create_file, revise_file},
};
use futures::executor::block_on;
use std::cell::RefCell;
use std::collections::BTreeMap;

#[derive(Default)]
struct Store(RefCell<BTreeMap<ContentId, Vec<u8>>>);

impl ObjectWriter for Store {
    async fn put(&self, bytes: &[u8]) -> Result<ContentId, Error> {
        let id = ContentId::for_bytes(bytes);
        self.0.borrow_mut().insert(id, bytes.to_vec());
        Ok(id)
    }
}

impl ObjectReader for Store {
    async fn get(&self, id: ContentId, max_bytes: usize) -> Result<Vec<u8>, Error> {
        let bytes = self.0.borrow().get(&id).cloned().ok_or(Error::NotFound)?;
        if bytes.len() > max_bytes {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
}

async fn build(reverse: bool) -> (Store, ContentId) {
    let store = Store::default();
    let namespace = ContentId::for_bytes(b"portable builder test");
    let mut builder = SnapshotBuilder::new(namespace, 0).unwrap();
    let paths = if reverse {
        ["/writer/b.md", "/writer/a.md"]
    } else {
        ["/writer/a.md", "/writer/b.md"]
    };
    for path in paths {
        builder.begin_file(path, 0, false).unwrap();
        builder.append_chunk(&store, b"hello ").await.unwrap();
        builder.append_chunk(&store, b"world").await.unwrap();
        builder.finish_file().unwrap();
    }
    builder.add_directory("/empty", 0).unwrap();
    builder.add_directory("/writer", 0).unwrap();
    let id = builder.finish(&store).await.unwrap();
    (store, id)
}

#[test]
fn portable_builder_is_sorted_pinned_and_byte_exact() {
    block_on(async {
        let (store, id) = build(false).await;
        let (_, reverse_id) = build(true).await;
        assert_eq!(id, reverse_id);
        let view = SnapshotView::open(&store, id).await.unwrap();
        assert_eq!(view.validate_tree().await.unwrap(), 5);
        let stats = view.validate_tree_stats().await.unwrap();
        assert_eq!(stats.nodes, 5);
        assert_eq!(stats.max_inode, 5);
        assert_eq!(stats.file_bytes, 22);
        let names: Vec<_> = view
            .list("/writer")
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, ["a.md", "b.md"]);
        assert_eq!(
            view.read_range("/writer/a.md", 4, 6).await.unwrap(),
            b"o worl"
        );
        assert!(view.list("/empty").await.unwrap().is_empty());
    });
}

#[test]
fn portable_builder_rejects_unsafe_and_conflicting_paths() {
    block_on(async {
        let store = Store::default();
        let mut builder = SnapshotBuilder::new(ContentId::for_bytes(b"scope"), 0).unwrap();
        assert!(builder.begin_file("/../escape", 0, false).is_err());
        assert!(builder.add_directory("/bad\\name", 0).is_err());
        builder.begin_file("/a.txt", 0, false).unwrap();
        assert!(builder.add_directory("/other", 0).is_err());
        assert!(builder.append_chunk(&store, b"").await.is_err());
        builder.finish_file().unwrap();
        assert!(builder.add_directory("/a.txt", 0).is_err());
        builder.begin_file("/a.txt", 0, false).unwrap();
        assert!(builder.finish_file().is_err());
    });
}

#[test]
fn revisions_preserve_old_root_and_stable_inodes() {
    block_on(async {
        let (store, base) = build(false).await;
        let old = SnapshotView::open(&store, base).await.unwrap();
        let old_inode = old.lookup("/writer/a.md").await.unwrap().inode;
        let replacement = b"revised";
        let replacement_id = store.put(replacement).await.unwrap();
        let changed = revise_file(
            &store,
            base,
            "/writer/a.md",
            StagedFile {
                modified_ms: 1,
                executable: false,
                chunks: vec![Chunk {
                    content: replacement_id,
                    size: replacement.len() as u32,
                }],
            },
        )
        .await
        .unwrap();
        let new = SnapshotView::open(&store, changed).await.unwrap();
        assert_eq!(new.snapshot().previous, Some(base));
        assert_eq!(new.snapshot().generation, 1);
        assert_eq!(new.lookup("/writer/a.md").await.unwrap().inode, old_inode);
        assert_eq!(
            old.read_range("/writer/a.md", 0, 20).await.unwrap(),
            b"hello world"
        );
        assert_eq!(
            new.read_range("/writer/a.md", 0, 20).await.unwrap(),
            replacement
        );
        assert_eq!(
            old.lookup("/writer/b.md").await.unwrap().manifest,
            new.lookup("/writer/b.md").await.unwrap().manifest
        );

        let added = revise_file(
            &store,
            changed,
            "/writer/new.bin",
            StagedFile {
                modified_ms: 2,
                executable: false,
                chunks: vec![Chunk {
                    content: replacement_id,
                    size: replacement.len() as u32,
                }],
            },
        )
        .await
        .unwrap();
        let newest = SnapshotView::open(&store, added).await.unwrap();
        assert!(newest.lookup("/writer/new.bin").await.unwrap().inode > old_inode);
        assert_eq!(newest.validate_tree().await.unwrap(), 6);
        assert!(old.lookup("/writer/new.bin").await.is_err());
    });
}

#[test]
fn revision_refuses_missing_or_corrupt_staged_chunks() {
    block_on(async {
        let (store, base) = build(false).await;
        let missing = ContentId::for_bytes(b"missing");
        assert!(
            revise_file(
                &store,
                base,
                "/writer/a.md",
                StagedFile {
                    modified_ms: 0,
                    executable: false,
                    chunks: vec![Chunk {
                        content: missing,
                        size: 7,
                    }],
                }
            )
            .await
            .is_err()
        );
        assert!(SnapshotView::open(&store, base).await.is_ok());
    });
}

#[test]
fn create_only_revisions_preserve_old_roots_and_empty_directories() {
    block_on(async {
        let (store, base) = build(false).await;
        let original = SnapshotView::open(&store, base).await.unwrap();
        let unchanged = original.lookup("/writer/a.md").await.unwrap();

        let folder = create_directory(&store, base, "/writer/new", 3)
            .await
            .unwrap();
        let folder_view = SnapshotView::open(&store, folder).await.unwrap();
        assert_eq!(folder_view.snapshot().previous, Some(base));
        assert_eq!(folder_view.snapshot().generation, 1);
        assert!(folder_view.list("/writer/new").await.unwrap().is_empty());
        assert!(original.lookup("/writer/new").await.is_err());
        assert_eq!(folder_view.lookup("/writer/a.md").await.unwrap(), unchanged);

        let nested = create_directory(&store, folder, "/writer/new/deeper", 4)
            .await
            .unwrap();
        let empty_file = create_file(
            &store,
            nested,
            "/writer/new/deeper/note.md",
            StagedFile {
                modified_ms: 5,
                executable: false,
                chunks: vec![],
            },
        )
        .await
        .unwrap();
        let latest = SnapshotView::open(&store, empty_file).await.unwrap();
        assert_eq!(latest.snapshot().generation, 3);
        assert_eq!(latest.snapshot().previous, Some(nested));
        assert_eq!(latest.validate_tree().await.unwrap(), 8);
        assert!(
            latest
                .read_range("/writer/new/deeper/note.md", 0, 1)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            create_directory(&store, empty_file, "/writer/new", 6)
                .await
                .is_err()
        );
        assert!(
            create_directory(&store, empty_file, "/writer/a.md/child", 6)
                .await
                .is_err()
        );
        assert!(
            create_directory(&store, empty_file, "/missing/child", 6)
                .await
                .is_err()
        );
        assert!(create_directory(&store, empty_file, "/", 6).await.is_err());
        for path in ["/writer/a.md", "/writer/new"] {
            assert!(
                create_file(
                    &store,
                    empty_file,
                    path,
                    StagedFile {
                        modified_ms: 6,
                        executable: false,
                        chunks: vec![],
                    },
                )
                .await
                .is_err()
            );
        }
    });
}
