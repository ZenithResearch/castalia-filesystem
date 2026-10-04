//! Offline portable snapshot demo; no remote upload or namespace authority.
use castalia_filesystem_core::*;
use futures::executor::block_on;
use std::collections::BTreeMap;

#[derive(Default)]
struct Objects(BTreeMap<ContentId, Vec<u8>>);
impl Objects {
    fn put(&mut self, bytes: Vec<u8>) -> ContentId {
        let id = ContentId::for_bytes(&bytes);
        self.0.insert(id, bytes);
        id
    }
    fn manifest(&mut self, node: Node) -> Result<ContentId, Error> {
        Ok(self.put(Manifest::new(node).encode()?))
    }
}
impl ObjectReader for Objects {
    async fn get(&self, id: ContentId, max_bytes: usize) -> Result<Vec<u8>, Error> {
        let bytes = self.0.get(&id).ok_or(Error::Unavailable)?;
        if bytes.len() > max_bytes {
            return Err(Error::Limit);
        }
        Ok(bytes.clone())
    }
}
fn main() -> Result<(), Error> {
    block_on(async {
        let mut objects = Objects::default();
        let bytes = b"Hello, pinned snapshot!\n";
        let chunk = objects.put(bytes.to_vec());
        let file = objects.manifest(Node::File(File {
            inode: 2,
            modified_ms: 0,
            executable: false,
            size: bytes.len() as u64,
            chunks: vec![Chunk {
                content: chunk,
                size: bytes.len() as u32,
            }],
        }))?;
        let directory = objects.manifest(Node::Directory(Directory::new(
            1,
            0,
            vec![Entry {
                name: "hello.md".into(),
                node: NodeRef {
                    inode: 2,
                    kind: NodeKind::File,
                    manifest: file,
                },
            }],
        )?))?;
        let root = objects.manifest(Node::Snapshot(Snapshot {
            namespace: ContentId::for_bytes(b"offline demo namespace"),
            generation: 0,
            previous: None,
            root: NodeRef {
                inode: 1,
                kind: NodeKind::Directory,
                manifest: directory,
            },
        }))?;
        let view = SnapshotView::open(&objects, root).await?;
        assert_eq!(view.validate_tree().await?, 2);
        let read = view.read_range("/hello.md", 0, 128).await?;
        assert_eq!(read, bytes);
        println!("snapshot: {}", String::from(view.id()));
        println!("entries: {:?}", view.list("/").await?);
        print!("{}", String::from_utf8_lossy(&read));
        Ok(())
    })
}
