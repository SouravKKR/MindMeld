//! Asks whether to install a newer version of the app, once per launch.
//!
//! THE UPDATER PLUGIN DOES NOT DO THIS BY ITSELF. Registering it only makes the
//! capability available; nothing checks anything until something calls `check()`.
//! Without this module the endpoint and the signing key are configured, every
//! release is signed, `latest.json` is published — and no installed app ever
//! looks at any of it. That failure is completely silent from the outside,
//! which is what makes it worth stating here rather than assuming.
//!
//! Deliberately on the Rust side rather than in the page. The frontend is
//! served from the live site, so driving the updater from there would mean
//! granting a remote origin permission to download and execute an installer —
//! a far larger thing to hand out than filesystem access, and unnecessary,
//! because updating the shell is the shell's own business and works the same
//! whatever the page is doing.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Checks for a newer release and offers to install it.
///
/// Spawned rather than awaited during setup: the check is a network round trip
/// to the update endpoint, and on a machine that is offline, behind a captive
/// portal, or simply slow, awaiting it would hold the window closed for as long
/// as the request takes. An update is never urgent enough to delay the app
/// starting.
///
/// Every failure path is a log line and nothing more. Not being able to reach
/// the update server is the normal condition for an offline learner — this app
/// is built to work without a network — and an error dialog for it would
/// interrupt the one session that most needs not to be interrupted.
pub fn check_in_background(app_handle: AppHandle)
{
    tauri::async_runtime::spawn(async move
    {
        let updater = match app_handle.updater()
        {
            Ok(updater) => updater,
            Err(updater_error) =>
            {
                eprintln!("[UpdatePrompter] The updater is unavailable: {updater_error}");
                return;
            }
        };

        let available_update = match updater.check().await
        {
            Ok(Some(available_update)) => available_update,
            Ok(None) => return,
            Err(check_error) =>
            {
                eprintln!("[UpdatePrompter] Could not check for updates: {check_error}");
                return;
            }
        };

        let current_version = app_handle.package_info().version.to_string();
        let offered_version = available_update.version.clone();

        if !ask_permission(&app_handle, &current_version, &offered_version).await
        {
            return;
        }

        // No progress reporting: the installers are a few megabytes, so the
        // download is over in about the time it takes to read the dialog that
        // authorised it. A progress bar for that would be more interruption
        // than the wait it describes.
        if let Err(install_error) = available_update.download_and_install(|_, _| {}, || {}).await
        {
            eprintln!("[UpdatePrompter] Could not install {offered_version}: {install_error}");

            app_handle
                .dialog()
                .message(format!("CogniumLearn {offered_version} could not be installed. It will be offered again next time you open the app."))
                .kind(MessageDialogKind::Warning)
                .title("Update failed")
                .blocking_show();
            return;
        }

        // Restarting is part of installing, not a separate favour to ask. The
        // running process is the old binary; leaving it running means the
        // learner keeps using the version they just replaced, and the update
        // appears not to have worked until they happen to quit.
        app_handle.restart();
    });
}

/// Asks before downloading anything.
///
/// It is the learner's machine, their bandwidth and their session — an app that
/// silently replaces itself mid-study and restarts is worse than one that is a
/// version behind. Declining is remembered for exactly this launch: the offer
/// returns next time, which is enough to be useful without becoming a thing to
/// dismiss every few minutes.
async fn ask_permission(app_handle: &AppHandle, current_version: &str, offered_version: &str) -> bool
{
    let (responder, response_receiver) = tokio::sync::oneshot::channel();

    // The callback form, not blocking_show(). This runs on the async runtime,
    // and blocking it on a dialog the learner may leave open for minutes would
    // stall every other task scheduled on it.
    app_handle
        .dialog()
        .message(format!(
            "CogniumLearn {offered_version} is available. You have {current_version}.\n\nInstall it now? The app will restart."
        ))
        .kind(MessageDialogKind::Info)
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom("Install".to_owned(), "Not now".to_owned()))
        .show(move |b_accepted|
        {
            let _ = responder.send(b_accepted);
        });

    response_receiver.await.unwrap_or(false)
}
