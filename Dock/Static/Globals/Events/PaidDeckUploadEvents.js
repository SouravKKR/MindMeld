/**
 * PaidDeckUploadEvents
 *
 * Window-level CustomEvent name for the client-side paid-deck upload
 * lifecycle. Fired by PaidDeckUploadActivitySource whenever the in-progress
 * upload's state changes, and listened to by the activity surface
 * (ActivityPreviewComponent badge, ActivityPage list, ActivityEntryComponent
 * row) so the upload's progress shows live in "View Activity" without polling.
 *
 * PROGRESS detail: {} — listeners re-read the current entry from
 * PaidDeckUploadActivitySource.getEntry().
 */
class PaidDeckUploadEvents
{
    static PROGRESS = "paid-deck-upload-progress";
}

export default PaidDeckUploadEvents;
