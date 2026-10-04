//! Browser-Worker bridge to the portable v1 snapshot reader.
//! The JavaScript object callback MUST enforce its byte cap before allocation.
//! This bridge verifies lengths and content IDs again after the callback returns.

#[cfg(target_arch = "wasm32")]
mod browser {
    use castalia_filesystem_core::{
        Chunk, ContentId, Error, MAX_CHUNK_BYTES, MAX_CHUNKS, Manifest, ObjectReader, ObjectWriter,
        SnapshotView,
        builder::SnapshotBuilder,
        reachable_ids_for_roots_bounded,
        revisions::{StagedFile, create_directory, create_file, revise_file},
    };
    use js_sys::{Function, Promise, Reflect, Uint8Array};
    use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};
    use wasm_bindgen_futures::JsFuture;

    fn js_error(error: Error) -> JsValue {
        JsValue::from_str(&error.to_string())
    }

    fn callback_error(value: JsValue, fallback: &'static str) -> Error {
        let code = Reflect::get(&value, &JsValue::from_str("code"))
            .ok()
            .and_then(|value| value.as_string());
        match code.as_deref() {
            Some("missing-object") => Error::NotFound,
            Some("oversized-object" | "integrity") => Error::Integrity,
            Some("storage-unavailable") => Error::Unavailable,
            Some("quota") => Error::Provider("quota".into()),
            _ => Error::Provider(fallback.into()),
        }
    }

    fn parse_id(value: String) -> Result<ContentId, JsValue> {
        ContentId::try_from(value).map_err(js_error)
    }

    struct CallbackReader<'a>(&'a Function);

    impl ObjectReader for CallbackReader<'_> {
        async fn get(&self, id: ContentId, max_bytes: usize) -> Result<Vec<u8>, Error> {
            let id_text = String::from(id);
            let result = self
                .0
                .call2(
                    &JsValue::NULL,
                    &JsValue::from_str(&id_text),
                    &JsValue::from_f64(max_bytes as f64),
                )
                .map_err(|error| callback_error(error, "object callback failed"))?;
            let result = JsFuture::from(Promise::resolve(&result))
                .await
                .map_err(|error| callback_error(error, "object callback rejected"))?;
            let bytes = result
                .dyn_into::<Uint8Array>()
                .map_err(|_| Error::Provider("object callback returned non-bytes".into()))?;
            if bytes.length() as usize > max_bytes {
                return Err(Error::Limit);
            }
            let bytes = bytes.to_vec();
            if ContentId::for_bytes(&bytes) != id {
                return Err(Error::Integrity);
            }
            Ok(bytes)
        }
    }

    struct CallbackWriter<'a>(&'a Function);

    impl ObjectWriter for CallbackWriter<'_> {
        async fn put(&self, bytes: &[u8]) -> Result<ContentId, Error> {
            let data = Uint8Array::from(bytes);
            let result = self
                .0
                .call1(&JsValue::NULL, &data)
                .map_err(|error| callback_error(error, "object writer failed"))?;
            let result = JsFuture::from(Promise::resolve(&result))
                .await
                .map_err(|error| callback_error(error, "object writer rejected"))?;
            let id = result
                .as_string()
                .ok_or_else(|| Error::Provider("object writer returned non-id".into()))?;
            ContentId::try_from(id)
        }
    }

    /// Round-trip only a strictly canonical v1 manifest; does not accept
    /// arbitrary JSON or revise the stored snapshot contract.
    #[wasm_bindgen]
    pub fn canonical_manifest(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        let id = ContentId::for_bytes(bytes);
        Manifest::decode(id, bytes)
            .and_then(|manifest| manifest.encode())
            .map_err(js_error)
    }

    #[wasm_bindgen]
    pub fn canonical_manifest_id(bytes: &[u8]) -> Result<String, JsValue> {
        let id = ContentId::for_bytes(bytes);
        Manifest::decode(id, bytes).map_err(js_error)?;
        Ok(String::from(id))
    }

    /// Content ID for a raw file chunk. Manifests should use
    /// `canonical_manifest_id` so malformed JSON cannot be blessed as v1.
    #[wasm_bindgen]
    pub fn content_id(bytes: &[u8]) -> String {
        String::from(ContentId::for_bytes(bytes))
    }

    /// `get_object(id, max_bytes)` may return a Uint8Array or a Promise of one.
    /// It is called inside a Worker, not on the UI thread. The implementation
    /// must reject oversized OPFS records before reading them into memory.
    #[wasm_bindgen]
    pub struct PinnedSnapshotReader {
        get_object: Function,
    }

    /// Portable generation-zero producer. A Worker streams bounded file
    /// chunks through this object; it does not pass the whole ZIP into WASM.
    /// `put_object(bytes)` must acknowledge only durable exact bytes and
    /// return their lowercase BLAKE3 content ID. Rust verifies that ID.
    #[wasm_bindgen]
    pub struct BrowserSnapshotBuilder {
        inner: Option<SnapshotBuilder>,
        put_object: Function,
    }

    /// Copy-on-write file addition/replacement. The host must compare the
    /// expected base root when selecting the returned immutable revision.
    #[wasm_bindgen]
    pub struct BrowserFileRevision {
        base: String,
        path: String,
        modified_ms: u64,
        executable: bool,
        chunks: Vec<Chunk>,
        get_object: Function,
        put_object: Function,
        finished: bool,
    }

    /// Copy-on-write empty directory addition. The host selects the returned
    /// root only after an expected-head comparison in its own catalog.
    #[wasm_bindgen]
    pub struct BrowserDirectoryRevision {
        base: String,
        path: String,
        modified_ms: u64,
        get_object: Function,
        put_object: Function,
        finished: bool,
    }

    struct CallbackStore<'a> {
        get: &'a Function,
        put: &'a Function,
    }

    impl ObjectReader for CallbackStore<'_> {
        async fn get(&self, id: ContentId, max_bytes: usize) -> Result<Vec<u8>, Error> {
            CallbackReader(self.get).get(id, max_bytes).await
        }
    }

    impl ObjectWriter for CallbackStore<'_> {
        async fn put(&self, bytes: &[u8]) -> Result<ContentId, Error> {
            CallbackWriter(self.put).put(bytes).await
        }
    }

    impl BrowserFileRevision {
        async fn finish_revision(&mut self, create_only: bool) -> Result<String, JsValue> {
            if self.finished {
                return Err(js_error(Error::Invalid("revision finished")));
            }
            self.finished = true;
            let staged = StagedFile {
                modified_ms: self.modified_ms,
                executable: self.executable,
                chunks: std::mem::take(&mut self.chunks),
            };
            let store = CallbackStore {
                get: &self.get_object,
                put: &self.put_object,
            };
            let base = parse_id(self.base.clone())?;
            let id = if create_only {
                create_file(&store, base, &self.path, staged).await
            } else {
                revise_file(&store, base, &self.path, staged).await
            };
            id.map(String::from).map_err(js_error)
        }
    }

    #[wasm_bindgen]
    impl BrowserFileRevision {
        #[wasm_bindgen(constructor)]
        pub fn new(
            base: String,
            path: String,
            modified_ms: u64,
            executable: bool,
            get_object: Function,
            put_object: Function,
        ) -> Result<Self, JsValue> {
            parse_id(base.clone())?;
            Ok(Self {
                base,
                path,
                modified_ms,
                executable,
                chunks: Vec::new(),
                get_object,
                put_object,
                finished: false,
            })
        }

        pub async fn append_chunk(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
            if self.finished
                || bytes.is_empty()
                || bytes.len() > MAX_CHUNK_BYTES
                || self.chunks.len() >= MAX_CHUNKS
            {
                return Err(js_error(Error::Limit));
            }
            let id = ContentId::for_bytes(bytes);
            if CallbackWriter(&self.put_object)
                .put(bytes)
                .await
                .map_err(js_error)?
                != id
            {
                return Err(js_error(Error::Integrity));
            }
            self.chunks.push(Chunk {
                content: id,
                size: bytes.len() as u32,
            });
            Ok(())
        }

        pub async fn finish(&mut self) -> Result<String, JsValue> {
            self.finish_revision(false).await
        }

        /// Create-only file addition. Refuses any existing leaf entry.
        pub async fn finish_new(&mut self) -> Result<String, JsValue> {
            self.finish_revision(true).await
        }
    }

    #[wasm_bindgen]
    impl BrowserDirectoryRevision {
        #[wasm_bindgen(constructor)]
        pub fn new(
            base: String,
            path: String,
            modified_ms: u64,
            get_object: Function,
            put_object: Function,
        ) -> Result<Self, JsValue> {
            parse_id(base.clone())?;
            Ok(Self {
                base,
                path,
                modified_ms,
                get_object,
                put_object,
                finished: false,
            })
        }

        pub async fn finish(&mut self) -> Result<String, JsValue> {
            if self.finished {
                return Err(js_error(Error::Invalid("revision finished")));
            }
            self.finished = true;
            create_directory(
                &CallbackStore {
                    get: &self.get_object,
                    put: &self.put_object,
                },
                parse_id(self.base.clone())?,
                &self.path,
                self.modified_ms,
            )
            .await
            .map(String::from)
            .map_err(js_error)
        }
    }

    #[wasm_bindgen]
    impl BrowserSnapshotBuilder {
        #[wasm_bindgen(constructor)]
        pub fn new(
            namespace: String,
            modified_ms: u64,
            put_object: Function,
        ) -> Result<Self, JsValue> {
            Ok(Self {
                inner: Some(
                    SnapshotBuilder::new(parse_id(namespace)?, modified_ms).map_err(js_error)?,
                ),
                put_object,
            })
        }

        pub fn add_directory(&mut self, path: String, modified_ms: u64) -> Result<(), JsValue> {
            self.inner
                .as_mut()
                .ok_or_else(|| js_error(Error::Invalid("builder finished")))?
                .add_directory(&path, modified_ms)
                .map_err(js_error)
        }

        pub fn begin_file(
            &mut self,
            path: String,
            modified_ms: u64,
            executable: bool,
        ) -> Result<(), JsValue> {
            self.inner
                .as_mut()
                .ok_or_else(|| js_error(Error::Invalid("builder finished")))?
                .begin_file(&path, modified_ms, executable)
                .map_err(js_error)
        }

        pub async fn append_chunk(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
            self.inner
                .as_mut()
                .ok_or_else(|| js_error(Error::Invalid("builder finished")))?
                .append_chunk(&CallbackWriter(&self.put_object), bytes)
                .await
                .map_err(js_error)
        }

        pub fn finish_file(&mut self) -> Result<(), JsValue> {
            self.inner
                .as_mut()
                .ok_or_else(|| js_error(Error::Invalid("builder finished")))?
                .finish_file()
                .map_err(js_error)
        }

        pub async fn finish(&mut self) -> Result<String, JsValue> {
            let builder = self
                .inner
                .take()
                .ok_or_else(|| js_error(Error::Invalid("builder finished")))?;
            let id = builder
                .finish(&CallbackWriter(&self.put_object))
                .await
                .map_err(js_error)?;
            Ok(String::from(id))
        }
    }

    #[wasm_bindgen]
    impl PinnedSnapshotReader {
        #[wasm_bindgen(constructor)]
        pub fn new(get_object: Function) -> Self {
            Self { get_object }
        }

        pub async fn validate_tree(&self, snapshot_id: String) -> Result<u32, JsValue> {
            let reader = CallbackReader(&self.get_object);
            let view = SnapshotView::open(&reader, parse_id(snapshot_id)?)
                .await
                .map_err(js_error)?;
            let count = view.validate_tree().await.map_err(js_error)?;
            u32::try_from(count).map_err(|_| js_error(Error::Limit))
        }

        /// Verify metadata and reject roots whose total logical file bytes
        /// exceed the host's bounded export policy. Does not read payloads.
        pub async fn validate_tree_bounded(
            &self,
            snapshot_id: String,
            max_file_bytes: u64,
        ) -> Result<u32, JsValue> {
            let reader = CallbackReader(&self.get_object);
            let view = SnapshotView::open(&reader, parse_id(snapshot_id)?)
                .await
                .map_err(js_error)?;
            let stats = view.validate_tree_stats().await.map_err(js_error)?;
            if stats.file_bytes > max_file_bytes {
                return Err(js_error(Error::Limit));
            }
            u32::try_from(stats.nodes).map_err(|_| js_error(Error::Limit))
        }

        /// Return a bounded, fully verified set of IDs for conservative local
        /// reclamation. This does not change the v1 snapshot wire format.
        pub async fn reachable_ids_bounded(
            &self,
            snapshot_id: String,
            max_objects: usize,
            max_bytes: u64,
        ) -> Result<String, JsValue> {
            let reader = CallbackReader(&self.get_object);
            let view = SnapshotView::open(&reader, parse_id(snapshot_id)?)
                .await
                .map_err(js_error)?;
            let ids = view
                .reachable_ids_bounded(max_objects, max_bytes)
                .await
                .map_err(js_error)?;
            let ids: Vec<String> = ids.into_iter().map(String::from).collect();
            serde_json::to_string(&ids).map_err(|error| JsValue::from_str(&error.to_string()))
        }

        /// Verify every retained root in one memoized scan with global visit
        /// and physical-read budgets. Errors never authorize deletion.
        pub async fn reachable_ids_for_roots_bounded(
            &self,
            roots_json: String,
            max_objects: usize,
            max_bytes: u64,
            max_visits: usize,
            max_read_bytes: u64,
        ) -> Result<String, JsValue> {
            let roots: Vec<String> =
                serde_json::from_str(&roots_json).map_err(|_| js_error(Error::Invalid("roots")))?;
            if roots.len() > 1024 {
                return Err(js_error(Error::Limit));
            }
            let roots = roots
                .into_iter()
                .map(parse_id)
                .collect::<Result<Vec<_>, _>>()?;
            let reader = CallbackReader(&self.get_object);
            let ids = reachable_ids_for_roots_bounded(
                &reader,
                &roots,
                max_objects,
                max_bytes,
                max_visits,
                max_read_bytes,
            )
            .await
            .map_err(js_error)?;
            let ids: Vec<String> = ids.into_iter().map(String::from).collect();
            serde_json::to_string(&ids).map_err(|error| JsValue::from_str(&error.to_string()))
        }

        pub async fn list(&self, snapshot_id: String, path: String) -> Result<String, JsValue> {
            let reader = CallbackReader(&self.get_object);
            let view = SnapshotView::open(&reader, parse_id(snapshot_id)?)
                .await
                .map_err(js_error)?;
            let entries = view.list(&path).await.map_err(js_error)?;
            serde_json::to_string(&entries).map_err(|error| JsValue::from_str(&error.to_string()))
        }

        pub async fn stat(&self, snapshot_id: String, path: String) -> Result<String, JsValue> {
            let reader = CallbackReader(&self.get_object);
            let view = SnapshotView::open(&reader, parse_id(snapshot_id)?)
                .await
                .map_err(js_error)?;
            let node = view.stat(&path).await.map_err(js_error)?;
            serde_json::to_string(&node).map_err(|error| JsValue::from_str(&error.to_string()))
        }

        pub async fn read_range(
            &self,
            snapshot_id: String,
            path: String,
            offset: u64,
            length: usize,
        ) -> Result<Vec<u8>, JsValue> {
            let reader = CallbackReader(&self.get_object);
            let view = SnapshotView::open(&reader, parse_id(snapshot_id)?)
                .await
                .map_err(js_error)?;
            view.read_range(&path, offset, length)
                .await
                .map_err(js_error)
        }
    }
}
