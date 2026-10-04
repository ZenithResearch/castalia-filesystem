use castalia_filesystem_core::*;
use futures::executor::block_on;
use std::cell::RefCell;
use std::collections::BTreeMap;

#[derive(Default)]
struct Store {
    objects: BTreeMap<ContentId, Vec<u8>>,
    requests: RefCell<Vec<(ContentId, usize)>>,
}
impl Store {
    fn put(&mut self, bytes: Vec<u8>) -> ContentId {
        let id = ContentId::for_bytes(&bytes);
        self.objects.insert(id, bytes);
        id
    }
    fn manifest(&mut self, node: Node) -> ContentId {
        self.put(Manifest::new(node).encode().unwrap())
    }
    fn file(&mut self, inode: u64, parts: &[&[u8]]) -> NodeRef {
        let chunks: Vec<_> = parts
            .iter()
            .map(|p| Chunk {
                content: self.put(p.to_vec()),
                size: p.len() as u32,
            })
            .collect();
        let size = chunks.iter().map(|c| u64::from(c.size)).sum();
        NodeRef {
            inode,
            kind: NodeKind::File,
            manifest: self.manifest(Node::File(File {
                inode,
                modified_ms: 0,
                executable: false,
                size,
                chunks,
            })),
        }
    }
    fn dir(&mut self, inode: u64, entries: Vec<Entry>) -> NodeRef {
        NodeRef {
            inode,
            kind: NodeKind::Directory,
            manifest: self.manifest(Node::Directory(Directory::new(inode, 0, entries).unwrap())),
        }
    }
    fn snapshot(&mut self, root: NodeRef, previous: Option<ContentId>) -> ContentId {
        self.manifest(Node::Snapshot(Snapshot {
            namespace: ContentId::for_bytes(b"test namespace"),
            generation: if previous.is_some() { 1 } else { 0 },
            previous,
            root,
        }))
    }
}
impl ObjectReader for Store {
    async fn get(&self, id: ContentId, max_bytes: usize) -> Result<Vec<u8>, Error> {
        self.requests.borrow_mut().push((id, max_bytes));
        let bytes = self.objects.get(&id).ok_or(Error::Unavailable)?;
        if bytes.len() > max_bytes {
            return Err(Error::Limit);
        }
        Ok(bytes.clone())
    }
}
fn entry(name: &str, node: NodeRef) -> Entry {
    Entry {
        name: name.into(),
        node,
    }
}
fn fixture() -> (Store, ContentId) {
    let mut store = Store::default();
    let file = store.file(3, &[b"abc", b"defg"]);
    let empty = store.file(4, &[]);
    let dir = store.dir(2, vec![entry("article.md", file)]);
    let root = store.dir(1, vec![entry("writer", dir), entry("empty", empty)]);
    let id = store.snapshot(root, None);
    (store, id)
}

#[test]
fn reachable_ids_include_payloads_and_fail_closed() {
    let (mut store, root) = fixture();
    let expected: Vec<_> = store.objects.keys().copied().collect();
    block_on(async {
        let view = SnapshotView::open(&store, root).await.unwrap();
        assert_eq!(
            view.reachable_ids_bounded(32, 1024 * 1024).await.unwrap(),
            expected
        );
        assert_eq!(
            view.reachable_ids_bounded(1, 1024 * 1024).await,
            Err(Error::Limit)
        );
        assert_eq!(view.reachable_ids_bounded(32, 1).await, Err(Error::Limit));
    });
    let payload = ContentId::for_bytes(b"abc");
    store.objects.remove(&payload);
    block_on(async {
        let view = SnapshotView::open(&store, root).await.unwrap();
        assert_eq!(
            view.reachable_ids_bounded(32, 1024 * 1024).await,
            Err(Error::Unavailable)
        );
    });
}

#[test]
fn retained_roots_share_verified_reads_and_obey_global_budgets() {
    let (mut store, first) = fixture();
    let root = {
        let first_view = block_on(SnapshotView::open(&store, first)).unwrap();
        first_view.snapshot().root.clone()
    };
    let second = store.snapshot(root, Some(first));
    let expected: Vec<_> = store.objects.keys().copied().collect();
    block_on(async {
        assert_eq!(
            reachable_ids_for_roots_bounded(
                &store,
                &[first, second],
                32,
                1024 * 1024,
                128,
                1024 * 1024,
            )
            .await
            .unwrap(),
            expected
        );
        assert_eq!(
            reachable_ids_for_roots_bounded(
                &store,
                &[first, second],
                32,
                1024 * 1024,
                1,
                1024 * 1024
            )
            .await,
            Err(Error::Limit)
        );
        assert_eq!(
            reachable_ids_for_roots_bounded(&store, &[first, second], 32, 1024 * 1024, 128, 1)
                .await,
            Err(Error::Limit)
        );
    });
    let requests = store.requests.borrow();
    let shared = ContentId::for_bytes(b"abc");
    assert_eq!(requests.iter().filter(|(id, _)| *id == shared).count(), 1);
    drop(requests);
    store.objects.remove(&shared);
    assert_eq!(
        block_on(reachable_ids_for_roots_bounded(
            &store,
            &[first, second],
            32,
            1024 * 1024,
            128,
            1024 * 1024,
        )),
        Err(Error::Unavailable)
    );
}

#[test]
fn golden_directory_encoder_and_decoder_agree() {
    let bytes = include_str!("../fixtures/empty-directory-v1.json")
        .trim_end()
        .as_bytes();
    let id = ContentId::for_bytes(bytes);
    let manifest = Manifest::decode(id, bytes).unwrap();
    assert_eq!(manifest.encode().unwrap(), bytes);
    assert_eq!(manifest.id().unwrap(), id);
    assert_eq!(
        String::from(id),
        "f1be639a408254dbc5b180987530d04647112010e221fc3ee04aa440b1af580f"
    );
    assert_eq!(
        manifest,
        Manifest::new(Node::Directory(Directory::new(1, 0, vec![]).unwrap()))
    );
}

#[test]
fn sorted_producer_input_is_deterministic() {
    let node = NodeRef {
        inode: 2,
        kind: NodeKind::File,
        manifest: ContentId::for_bytes(b"file"),
    };
    let a = entry("a", node.clone());
    let b = entry("b", node.clone());
    let c = entry("c", node);
    let expected = Manifest::new(Node::Directory(
        Directory::new(1, 0, vec![a.clone(), b.clone(), c.clone()]).unwrap(),
    ))
    .id()
    .unwrap();
    for entries in [
        vec![c.clone(), b.clone(), a.clone()],
        vec![b.clone(), a.clone(), c.clone()],
        vec![a, c, b],
    ] {
        assert_eq!(
            Manifest::new(Node::Directory(Directory::new(1, 0, entries).unwrap()))
                .id()
                .unwrap(),
            expected
        );
    }
}

#[test]
fn unsafe_and_duplicate_names_are_rejected() {
    let node = NodeRef {
        inode: 2,
        kind: NodeKind::File,
        manifest: ContentId::for_bytes(b"file"),
    };
    for bad in ["", ".", "..", "a/b", "a\\b", "nul\0", "line\n"] {
        assert!(Directory::new(1, 0, vec![entry(bad, node.clone())]).is_err());
    }
    assert!(
        Directory::new(
            1,
            0,
            vec![entry("same", node.clone()), entry("same", node.clone())]
        )
        .is_err()
    );
    // Case and Unicode are preserved, not silently normalized/folded.
    assert!(
        Directory::new(
            1,
            0,
            vec![
                entry("A", node.clone()),
                entry("a", node.clone()),
                entry("é", node)
            ]
        )
        .is_ok()
    );
}

#[test]
fn strict_decoder_rejects_unknown_duplicate_noncanonical_and_future_version() {
    let good = include_str!("../fixtures/empty-directory-v1.json").trim_end();
    for bad in [
        format!(" {good}"),
        good.replace("\"inode\":1", "\"inode\":1,\"extra\":true"),
        good.replace("\"inode\":1", "\"inode\":1,\"inode\":2"),
        good.replace("\"schema_version\":1", "\"schema_version\":2"),
        good.replace("\"inode\":1", "\"inode\":1.0"),
        good.replace("\"inode\":1", "\"inode\":9007199254740992"),
    ] {
        assert!(
            Manifest::decode(ContentId::for_bytes(bad.as_bytes()), bad.as_bytes()).is_err(),
            "{bad}"
        );
    }
    assert_eq!(
        Manifest::decode(ContentId::for_bytes(b"wrong"), good.as_bytes()),
        Err(Error::Integrity)
    );
    let oversized = vec![0; MAX_MANIFEST_BYTES + 1];
    assert_eq!(
        Manifest::decode(ContentId::for_bytes(&oversized), &oversized),
        Err(Error::Limit)
    );
}

#[test]
fn hash_wire_format_is_strict_and_roundtrips() {
    let id = ContentId::for_bytes(b"object");
    assert_eq!(ContentId::try_from(String::from(id)).unwrap(), id);
    for bad in [
        "A".repeat(64),
        "z".repeat(64),
        "0".repeat(63),
        "é".repeat(32),
    ] {
        assert!(ContentId::try_from(bad).is_err());
    }
}

#[test]
fn file_size_chunk_and_inode_limits_are_enforced() {
    let base = File {
        inode: 1,
        modified_ms: 0,
        executable: false,
        size: 1,
        chunks: vec![Chunk {
            content: ContentId::for_bytes(b"a"),
            size: 1,
        }],
    };
    let mut bad = base.clone();
    bad.size = 2;
    assert!(Manifest::new(Node::File(bad)).encode().is_err());
    let mut bad = base.clone();
    bad.inode = 0;
    assert!(Manifest::new(Node::File(bad)).encode().is_err());
    let mut bad = base.clone();
    bad.modified_ms = MAX_SAFE_INTEGER + 1;
    assert!(Manifest::new(Node::File(bad)).encode().is_err());
    for size in [0, MAX_CHUNK_BYTES as u32 + 1] {
        let mut bad = base.clone();
        bad.chunks[0].size = size;
        bad.size = size.into();
        assert!(Manifest::new(Node::File(bad)).encode().is_err());
    }
    let mut bad = base.clone();
    bad.chunks = vec![base.chunks[0].clone(); MAX_CHUNKS + 1];
    assert_eq!(Manifest::new(Node::File(bad)).validate(), Err(Error::Limit));
}

#[test]
fn nested_list_stat_and_all_cross_chunk_ranges() {
    block_on(async {
        let (store, id) = fixture();
        let view = SnapshotView::open(&store, id).await.unwrap();
        assert_eq!(view.validate_tree().await.unwrap(), 4);
        assert_eq!(
            view.list("/")
                .await
                .unwrap()
                .iter()
                .map(|e| e.name.as_str())
                .collect::<Vec<_>>(),
            ["empty", "writer"]
        );
        assert_eq!(view.lookup("/writer/article.md").await.unwrap().inode, 3);
        let source = b"abcdefg";
        for offset in 0..=10 {
            for length in 0..=10 {
                let lo = (offset as usize).min(source.len());
                let hi = (lo + length).min(source.len());
                assert_eq!(
                    view.read_range("/writer/article.md", offset, length)
                        .await
                        .unwrap(),
                    &source[lo..hi]
                );
            }
        }
        assert!(view.read_range("/empty", 0, 10).await.unwrap().is_empty());
        assert_eq!(
            view.read_range("/empty", 0, MAX_READ_BYTES + 1).await,
            Err(Error::Limit)
        );
        assert!(
            store
                .requests
                .borrow()
                .iter()
                .all(|(_, cap)| *cap <= MAX_MANIFEST_BYTES)
        );
    });
}

#[test]
fn paths_and_wrong_node_kinds_are_rejected() {
    block_on(async {
        let (store, id) = fixture();
        let view = SnapshotView::open(&store, id).await.unwrap();
        for path in [
            "writer",
            "/../writer",
            "/writer/./article.md",
            "/writer//article.md",
            "/writer/",
            "/writer\\article.md",
        ] {
            assert!(view.lookup(path).await.is_err());
        }
        assert_eq!(view.lookup("/missing").await, Err(Error::NotFound));
        assert_eq!(view.lookup("/empty/child").await, Err(Error::NotDirectory));
        assert_eq!(view.list("/empty").await, Err(Error::NotDirectory));
        assert_eq!(view.read_range("/writer", 0, 1).await, Err(Error::NotFile));
    });
}

#[test]
fn corrupted_chunks_are_never_served_and_only_requested_chunks_are_fetched() {
    block_on(async {
        let (mut store, id) = fixture();
        let chunk = ContentId::for_bytes(b"defg");
        store.objects.insert(chunk, b"evil".to_vec());
        let view = SnapshotView::open(&store, id).await.unwrap();
        assert_eq!(
            view.read_range("/writer/article.md", 0, 2).await.unwrap(),
            b"ab"
        );
        assert!(!store.requests.borrow().iter().any(|(id, _)| *id == chunk));
        assert_eq!(
            view.read_range("/writer/article.md", 3, 1).await,
            Err(Error::Integrity)
        );
    });
}

#[test]
fn metadata_reference_mismatch_and_inode_aliases_fail() {
    block_on(async {
        let mut store = Store::default();
        let file = store.file(2, &[b"a"]);
        let root = store.dir(1, vec![entry("a", file.clone()), entry("b", file.clone())]);
        let id = store.snapshot(root, None);
        let view = SnapshotView::open(&store, id).await.unwrap();
        assert_eq!(
            view.validate_tree().await,
            Err(Error::Invalid("inode alias"))
        );
        let mut wrong = file;
        wrong.inode = 3;
        let root = store.dir(1, vec![entry("wrong", wrong)]);
        let id = store.snapshot(root, None);
        let view = SnapshotView::open(&store, id).await.unwrap();
        assert_eq!(
            view.lookup("/wrong").await,
            Err(Error::Invalid("node reference"))
        );
        assert!(view.validate_tree().await.is_err());
    });
}

#[test]
fn missing_references_fail_explicitly() {
    block_on(async {
        let mut store = Store::default();
        let missing = NodeRef {
            inode: 2,
            kind: NodeKind::File,
            manifest: ContentId::for_bytes(b"missing"),
        };
        let root = store.dir(1, vec![entry("missing", missing)]);
        let id = store.snapshot(root, None);
        let view = SnapshotView::open(&store, id).await.unwrap();
        assert_eq!(view.lookup("/missing").await, Err(Error::Unavailable));
        assert_eq!(view.validate_tree().await, Err(Error::Unavailable));
    });
}

#[test]
fn pinned_revisions_preserve_inode_and_independent_content() {
    block_on(async {
        let mut store = Store::default();
        let file = store.file(2, &[b"old"]);
        let root = store.dir(1, vec![entry("post", file)]);
        let old = store.snapshot(root, None);
        let file = store.file(2, &[b"new"]);
        let root = store.dir(1, vec![entry("renamed", file)]);
        let new = store.snapshot(root, Some(old));
        let a = SnapshotView::open(&store, old).await.unwrap();
        let b = SnapshotView::open(&store, new).await.unwrap();
        assert_eq!(a.read_range("/post", 0, 10).await.unwrap(), b"old");
        assert_eq!(b.read_range("/renamed", 0, 10).await.unwrap(), b"new");
        assert_eq!(
            a.lookup("/post").await.unwrap().inode,
            b.lookup("/renamed").await.unwrap().inode
        );
        assert_eq!(a.lookup("/renamed").await, Err(Error::NotFound));
        assert_eq!(b.snapshot().previous, Some(old));
        assert_ne!(a.id(), b.id());
    });
}

#[test]
fn predecessor_shape_and_tree_depth_are_bounded() {
    block_on(async {
        let mut store = Store::default();
        let mut root = store.dir(100, vec![]);
        let invalid = Snapshot {
            namespace: ContentId::for_bytes(b"ns"),
            generation: 0,
            previous: Some(ContentId::for_bytes(b"prior")),
            root: root.clone(),
        };
        assert!(Manifest::new(Node::Snapshot(invalid)).validate().is_err());
        for i in 0..=MAX_DEPTH {
            root = store.dir(i as u64 + 1, vec![entry("d", root)]);
        }
        let id = store.snapshot(root, None);
        let view = SnapshotView::open(&store, id).await.unwrap();
        assert_eq!(view.validate_tree().await, Err(Error::Limit));
    });
}

#[test]
fn unsorted_directory_and_entry_count_are_rejected_without_repair() {
    let node = NodeRef {
        inode: 2,
        kind: NodeKind::File,
        manifest: ContentId::for_bytes(b"file"),
    };
    let unsorted = Manifest::new(Node::Directory(Directory {
        inode: 1,
        modified_ms: 0,
        entries: vec![entry("z", node.clone()), entry("a", node.clone())],
    }));
    let bytes = serde_json::to_vec(&unsorted).unwrap();
    assert_eq!(
        Manifest::decode(ContentId::for_bytes(&bytes), &bytes),
        Err(Error::Invalid("unsorted or duplicate entry"))
    );
    assert_eq!(
        Manifest::new(Node::Directory(Directory {
            inode: 1,
            modified_ms: 0,
            entries: vec![entry("a", node); MAX_ENTRIES + 1],
        }))
        .validate(),
        Err(Error::Limit)
    );
}

#[test]
fn reader_returning_oversized_manifest_is_rejected() {
    struct IgnoringCap;
    impl ObjectReader for IgnoringCap {
        async fn get(&self, _: ContentId, _: usize) -> Result<Vec<u8>, Error> {
            Ok(vec![0; MAX_MANIFEST_BYTES + 1])
        }
    }
    block_on(async {
        assert!(matches!(
            SnapshotView::open(&IgnoringCap, ContentId::for_bytes(b"x")).await,
            Err(Error::Limit)
        ));
    });
}

#[test]
fn full_sized_chunk_read_is_bounded_and_wrong_reference_kind_fails() {
    block_on(async {
        let mut store = Store::default();
        let bytes = vec![42; MAX_CHUNK_BYTES];
        let file = store.file(2, &[&bytes]);
        let root = store.dir(1, vec![entry("large", file.clone())]);
        let id = store.snapshot(root, None);
        let view = SnapshotView::open(&store, id).await.unwrap();
        assert_eq!(
            view.read_range("/large", MAX_CHUNK_BYTES as u64 - 2, 4)
                .await
                .unwrap(),
            [42, 42]
        );
        assert!(
            store
                .requests
                .borrow()
                .iter()
                .any(|(id, cap)| *id == ContentId::for_bytes(&bytes) && *cap == MAX_CHUNK_BYTES)
        );
        let mut wrong = file;
        wrong.kind = NodeKind::Directory;
        let root = store.dir(1, vec![entry("wrong", wrong)]);
        let id = store.snapshot(root, None);
        let view = SnapshotView::open(&store, id).await.unwrap();
        assert_eq!(
            view.lookup("/wrong").await,
            Err(Error::Invalid("node reference"))
        );
    });
}
