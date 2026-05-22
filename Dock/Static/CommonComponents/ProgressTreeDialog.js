import DialogBox from "./DialogBox.js";
import { taskStatus } from "../Globals/Enumerations/TaskStatus.js";
import { taskTypes } from "../Globals/Enumerations/TaskTypes.js";


/**
 * ProgressTreeDialog
 *
 * Opens a DialogBox.modal that polls the recursive task progress tree
 * (`GET /Activity/Tasks/Progress?taskid=...`) and renders one row per
 * descendant with its own progress bar. Reused by:
 *   - ActivityPreviewComponent's "View" button (in-progress task)
 *   - ActivityEntryComponent's row action (any task entry)
 *
 * Polling stops when:
 *   - the user closes the dialog,
 *   - the root task transitions to COMPLETED or FAILED, OR
 *   - the page is hidden (document.visibilityState === "hidden").
 */
class ProgressTreeDialog
{
    static #POLL_INTERVAL_MILLIS = 2000;
    static #ENDPOINT = "/Activity/Tasks/Progress";

    /**
     * Opens the dialog and starts polling. Resolves when the dialog
     * is dismissed by the user. Errors are surfaced inside the dialog
     * itself rather than thrown.
     * @param {string} taskId
     */
    static async show(taskId)
    {
        if (!taskId)
        {
            return;
        }

        const dialog = DialogBox.modal
        (`
            <div class="progress-tree-dialog">
                <h2 class="progress-tree-dialog-title">Task progress</h2>
                <div class="progress-tree-dialog-body" data-role="body">
                    <div class="progress-tree-dialog-loading">Loading…</div>
                </div>
            </div>
        `);

        const bodyElement = dialog.querySelector('[data-role="body"]');

        let pollHandle = null;
        let bDisposed = false;

        const teardown = () =>
        {
            if (bDisposed)
            {
                return;
            }
            bDisposed = true;
            if (pollHandle !== null)
            {
                clearTimeout(pollHandle);
                pollHandle = null;
            }
            document.removeEventListener("visibilitychange", handleVisibility);
        };

        const handleVisibility = () =>
        {
            if (document.visibilityState === "hidden")
            {
                if (pollHandle !== null)
                {
                    clearTimeout(pollHandle);
                    pollHandle = null;
                }
            }
            else if (!bDisposed && pollHandle === null)
            {
                pollOnce();
            }
        };

        const onClose = () =>
        {
            teardown();
        };

        // DialogBox.modal returns the dialog element directly; user-driven
        // closes route through its `.close()` method. Hook a MutationObserver
        // to detect removal from the DOM so we can stop polling.
        const removalObserver = new MutationObserver(() =>
        {
            if (!document.body.contains(dialog))
            {
                onClose();
                removalObserver.disconnect();
            }
        });
        removalObserver.observe(document.body, { childList: true, subtree: false });

        document.addEventListener("visibilitychange", handleVisibility);

        const pollOnce = async () =>
        {
            if (bDisposed)
            {
                return;
            }
            try
            {
                const response = await fetch(`${ProgressTreeDialog.#ENDPOINT}?taskid=${encodeURIComponent(taskId)}`);

                if (bDisposed)
                {
                    return;
                }

                if (!response.ok)
                {
                    bodyElement.innerHTML = `<div class="progress-tree-dialog-error">HTTP ${response.status}</div>`;
                    return;
                }

                const tree = await response.json();
                bodyElement.innerHTML = ProgressTreeDialog.#renderTree(tree);

                const rootStatus = tree?.status;
                const isTerminal = rootStatus === taskStatus.COMPLETED || rootStatus === taskStatus.FAILED;
                if (!isTerminal)
                {
                    pollHandle = setTimeout(pollOnce, ProgressTreeDialog.#POLL_INTERVAL_MILLIS);
                }
            }
            catch (pollError)
            {
                if (bDisposed)
                {
                    return;
                }
                bodyElement.innerHTML = `<div class="progress-tree-dialog-error">${ProgressTreeDialog.#escape(pollError.message)}</div>`;
                pollHandle = setTimeout(pollOnce, ProgressTreeDialog.#POLL_INTERVAL_MILLIS);
            }
        };

        pollOnce();
    }

    static #renderTree(tree)
    {
        if (!tree)
        {
            return `<div class="progress-tree-dialog-empty">Task not found.</div>`;
        }
        return `<div class="progress-tree-list">${ProgressTreeDialog.#renderNode(tree, 0)}</div>`;
    }

    static #renderNode(node, depth)
    {
        const indent = depth * 16;
        const completionPercent = Math.round(Math.max(0, Math.min(1, node.completion || 0)) * 100);
        const statusLabel = ProgressTreeDialog.#statusLabel(node.status);
        const statusClass = ProgressTreeDialog.#statusClass(node.status);
        const typeLabel = ProgressTreeDialog.#humaniseType(node.type);

        const childrenHtml = Array.isArray(node.children) && node.children.length > 0
            ? node.children.map((childNode) => ProgressTreeDialog.#renderNode(childNode, depth + 1)).join("")
            : "";

        return `
            <div class="progress-tree-node" style="padding-left: ${indent}px">
                <div class="progress-tree-node-row">
                    <span class="progress-tree-node-label">${ProgressTreeDialog.#escape(typeLabel)}</span>
                    <span class="progress-tree-node-status ${statusClass}">${ProgressTreeDialog.#escape(statusLabel)}</span>
                    <span class="progress-tree-node-percent">${completionPercent}%</span>
                </div>
                <div class="progress-tree-node-bar">
                    <div class="progress-tree-node-bar-fill" style="width: ${completionPercent}%"></div>
                </div>
                ${childrenHtml}
            </div>
        `;
    }

    static #statusLabel(statusValue)
    {
        for (const statusName of Object.keys(taskStatus))
        {
            if (taskStatus[statusName] === statusValue)
            {
                return statusName.replace(/_/g, " ");
            }
        }
        return "Unknown";
    }

    static #statusClass(statusValue)
    {
        if (statusValue === taskStatus.COMPLETED) return "progress-tree-status-completed";
        if (statusValue === taskStatus.FAILED) return "progress-tree-status-failed";
        if (statusValue === taskStatus.IN_PROGRESS) return "progress-tree-status-in-progress";
        return "progress-tree-status-pending";
    }

    static #humaniseType(typeValue)
    {
        for (const typeName of Object.keys(taskTypes))
        {
            if (taskTypes[typeName] === typeValue)
            {
                return typeName.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (firstChar) => firstChar.toUpperCase());
            }
        }
        return "Task";
    }

    static #escape(rawString)
    {
        if (rawString === null || rawString === undefined) return "";
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default ProgressTreeDialog;
