//! Bounded, post-order snapshot replication between object adapters.
use crate::*;

#[derive(Debug, Clone, Copy)]
pub struct TransferBudget {
    pub max_objects: usize,
    pub max_bytes: u64,
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct TransferReport {
    pub objects: usize,
    pub bytes: u64,
}

async fn copy<R: ObjectReader, W: ObjectWriter>(
    reader: &R,
    writer: &W,
    id: ContentId,
    cap: usize,
    exact_size: Option<usize>,
    budget: TransferBudget,
    report: &mut TransferReport,
) -> Result<(), Error> {
    if report.objects >= budget.max_objects {
        return Err(Error::Limit);
    }
    let bytes = reader.get(id, cap).await?;
    if bytes.len() > cap
        || exact_size.is_some_and(|size| bytes.len() != size)
        || ContentId::for_bytes(&bytes) != id
    {
        return Err(Error::Integrity);
    }
    let total = report
        .bytes
        .checked_add(bytes.len() as u64)
        .ok_or(Error::Limit)?;
    if total > budget.max_bytes {
        return Err(Error::Limit);
    }
    if writer.put(&bytes).await? != id {
        return Err(Error::Integrity);
    }
    report.objects += 1;
    report.bytes = total;
    Ok(())
}
/// Copies reachable content before its referring manifests, snapshot last.
/// Snapshot ID success is not an authenticated mutable-head update. Budget
/// counts logical puts (including repeats); Sia catalog may deduplicate them.
pub async fn copy_snapshot<R: ObjectReader, W: ObjectWriter>(
    reader: &R,
    writer: &W,
    id: ContentId,
    budget: TransferBudget,
) -> Result<TransferReport, Error> {
    let view = SnapshotView::open(reader, id).await?;
    view.validate_tree().await?;
    let mut report = TransferReport::default();
    let mut stack = vec![(view.snapshot().root.clone(), false)];
    while let Some((reference, after_children)) = stack.pop() {
        if after_children {
            copy(
                reader,
                writer,
                reference.manifest,
                MAX_MANIFEST_BYTES,
                None,
                budget,
                &mut report,
            )
            .await?;
            continue;
        }
        match crate::checked_node(reader, &reference).await? {
            Node::Directory(dir) => {
                if stack.len() + dir.entries.len() + 1 > MAX_TREE_NODES * 2 {
                    return Err(Error::Limit);
                }
                stack.push((reference, true));
                stack.extend(dir.entries.into_iter().rev().map(|e| (e.node, false)));
            }
            Node::File(file) => {
                for chunk in file.chunks {
                    copy(
                        reader,
                        writer,
                        chunk.content,
                        chunk.size as usize,
                        Some(chunk.size as usize),
                        budget,
                        &mut report,
                    )
                    .await?;
                }
                copy(
                    reader,
                    writer,
                    reference.manifest,
                    MAX_MANIFEST_BYTES,
                    None,
                    budget,
                    &mut report,
                )
                .await?;
            }
            Node::Snapshot(_) => return Err(Error::Invalid("snapshot child")),
        }
    }
    copy(
        reader,
        writer,
        id,
        MAX_MANIFEST_BYTES,
        None,
        budget,
        &mut report,
    )
    .await?;
    Ok(report)
}

/// Fallback is explicit and scoped by content IDs (which the caller must derive
/// from authenticated receipt/policy evidence). Integrity failures never fall
/// back silently. Both transports are checked before bytes leave this adapter.
pub struct VerifiedFallback<'a, P, M> {
    pub primary: &'a P,
    pub mirror: &'a M,
    pub allowed_mirror_ids: &'a std::collections::BTreeSet<ContentId>,
}
impl<P: ObjectReader, M: ObjectReader> ObjectReader for VerifiedFallback<'_, P, M> {
    async fn get(&self, id: ContentId, cap: usize) -> Result<Vec<u8>, Error> {
        let bytes = match self.primary.get(id, cap).await {
            Ok(bytes) => bytes,
            Err(Error::Unavailable | Error::Transport(_))
                if self.allowed_mirror_ids.contains(&id) =>
            {
                self.mirror.get(id, cap).await?
            }
            Err(e) => return Err(e),
        };
        if bytes.len() > cap || ContentId::for_bytes(&bytes) != id {
            return Err(Error::Integrity);
        }
        Ok(bytes)
    }
}
