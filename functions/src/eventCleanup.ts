// RTDB event retention.
//
// /{projectId}/events/{rfId}/{timestamp} is append-only: onSensorEvent
// mirrors each event into Firestore but never deletes the RTDB node, so the
// database grew without bound. Firestore is the durable copy kept for
// analysis; RTDB is a live buffer holding only the last 24h.
//
// Retention is deliberately the same for paired and unpaired sensors.
// Paired-sensor events survive in the Firestore timeline. Unpaired ones do
// not — they have no Firestore copy at all (onSensorEvent returns early for
// an unknown rfId) — but they exist to make pairing possible, and the web
// UI's pairing view only surfaces sightings from the last 24h anyway
// (web/src/features/configure/SensorsTab.tsx). Beyond that window they are
// noise.
//
// No attempt is made to verify a Firestore counterpart exists before
// deleting. Mirroring runs once, at write time, with no retry, so a failed
// invocation loses an event. That race is accepted: the normal path mirrors
// reliably, and a handful of lost events does not justify a read per event.

import { rtdb } from "./admin";
import { expiredKeys } from "./eventRetention";

export { EVENT_RETENTION_MS, cutoffFrom, expiredKeys } from "./eventRetention";

/**
 * Delete every event older than `cutoffMs` under one project. Returns the
 * number of events removed, for logging.
 *
 * Per rfId, only the expiring keys are fetched — orderByKey().endAt(cutoff)
 * bounds the read to the nodes about to be deleted, so a project with a long
 * history does not pull that history into memory. Deletions for one rfId go
 * out as a single multi-path update rather than one write per event.
 *
 * Discovering the rfId list costs one read of the events node — see
 * listRfIds for why that is acceptable and what it costs on the first run.
 * The per-rfId query therefore re-reads data listRfIds already fetched. That
 * redundancy is kept on purpose: it makes this loop bounded on its own terms,
 * so swapping listRfIds for a REST shallow read needs no change here.
 */
export async function cleanupProjectEvents(
  projectId: string,
  cutoffMs: number
): Promise<number> {
  const eventsRef = rtdb.ref(`${projectId}/events`);

  const rfIds = await listRfIds(eventsRef);
  let removed = 0;

  for (const rfId of rfIds) {
    // endAt is inclusive, so an event landing exactly on the cutoff would be
    // included; expiredKeys re-filters to strictly-older and is the single
    // source of truth for the boundary.
    const expiringSnap = await eventsRef
      .child(rfId)
      .orderByKey()
      .endAt(String(cutoffMs))
      .get();

    const keys: string[] = [];
    expiringSnap.forEach((child) => {
      if (child.key !== null) keys.push(child.key);
    });

    const doomed = expiredKeys(keys, cutoffMs);
    if (doomed.length === 0) continue;

    const updates: Record<string, null> = {};
    for (const key of doomed) updates[key] = null;
    await eventsRef.child(rfId).update(updates);
    removed += doomed.length;
  }

  return removed;
}

/**
 * The rfId child names under an events node.
 *
 * This reads the events node in full, including payloads. The Admin SDK has
 * no shallow read (`?shallow=true` is REST-only) and no query returns child
 * names without their values — limitToLast/limitToFirst bound the number of
 * children, not the depth beneath each one.
 *
 * That full read is acceptable in steady state: once this cleanup has run,
 * the node holds at most 24h of events, which is the same volume the web
 * UI's Sensors tab already subscribes to on every page load
 * (web/src/features/configure/SensorsTab.tsx). The cost lands on the FIRST
 * run against an install with a long backlog — a one-off, in a scheduled
 * function with no user waiting on it. Should that read ever prove too
 * large, the fix is a REST GET with ?shallow=true rather than a query.
 */
async function listRfIds(
  eventsRef: ReturnType<typeof rtdb.ref>
): Promise<string[]> {
  const snap = await eventsRef.get();
  const rfIds: string[] = [];
  snap.forEach((child) => {
    if (child.key !== null) rfIds.push(child.key);
  });
  return rfIds;
}
