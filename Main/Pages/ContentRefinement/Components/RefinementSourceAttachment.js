import DialogBox from "../../../CommonComponents/DialogBox.js";
import SourceLicenceDeclarationForm from "../../../CommonComponents/SourceLicenceDeclarationForm.js";

/**
 * RefinementSourceAttachment — attaches a reference to one correction and
 * records the licence its user declares for it.
 *
 * Three ways to work: no reference at all (the expert simply knows the answer),
 * a URL for the model to consult, or a document the expert uploads.
 *
 * The licence declaration is mandatory on an attached document and is the entire
 * reason this component exists rather than a bare file input. Content produced
 * by the paid-deck pipeline is defensible because the pipeline demonstrably had
 * no third-party document to work from; a correction made against someone else's
 * material steps outside that argument and needs its own basis. Recording who
 * declared what, and keeping the document retrievable afterwards, is that basis.
 *
 * The declaration is a claim by the person making it, not a verification. The
 * wording says so, because a form that implies the platform checked would be
 * worse than one that makes the responsibility explicit.
 */
class RefinementSourceAttachment
{
    static #UPLOAD_ENDPOINT = "/InformationSource/Upload";

    #hostElement = null;
    #informationSourceId = "";
    #attachedFileName = "";

    mount(hostElement)
    {
        this.#hostElement = hostElement;

        hostElement.innerHTML = `
            <div class="refinement-source-attachment">
                <label class="refinement-source-field">
                    <span>Reference URL (optional)</span>
                    <input type="url" data-role="reference-url" placeholder="https://…" maxlength="2048">
                </label>
                <div class="refinement-source-upload">
                    <button type="button" data-role="attach-document">Attach a reference document</button>
                    <span class="refinement-source-attached" data-role="attached-name" hidden></span>
                    <button type="button" class="refinement-source-detach" data-role="detach-document" hidden>Remove</button>
                </div>
                <div class="refinement-source-note">
                    A reference is optional. If you attach a document you will be asked to declare the basis on which
                    it may be used; the document is kept as a record of that declaration and cannot be deleted while
                    a correction relies on it.
                </div>
            </div>
        `;

        hostElement.querySelector('[data-role="attach-document"]')
            .addEventListener("click", () => this.#promptForDocument());

        hostElement.querySelector('[data-role="detach-document"]')
            .addEventListener("click", () => this.#detachDocument());
    }

    getInformationSourceId()
    {
        return this.#informationSourceId;
    }

    getReferenceUrl()
    {
        const urlInput = this.#hostElement ? this.#hostElement.querySelector('[data-role="reference-url"]') : null;
        return urlInput ? urlInput.value.trim() : "";
    }

    async #promptForDocument()
    {
        // The URL field is omitted here: this component already has its own
        // reference-URL input above, and asking for a second URL inside the
        // declaration would present two boxes for one fact.
        const declaration = await SourceLicenceDeclarationForm.prompt({
            title: "On what basis may this document be used?",
            message: "This correction will go into content that is sold. Declare the basis on which the material may "
                + "be used — you are stating this, and the document is retained alongside your declaration so it "
                + "can be produced later.",
            bShowUrlField: false,
        });

        if (declaration === null)
        {
            return;
        }

        const selectedFile = await RefinementSourceAttachment.#pickFile();

        if (selectedFile === null)
        {
            return;
        }

        try
        {
            this.#informationSourceId = await RefinementSourceAttachment.#uploadDocument(selectedFile, declaration);
            this.#attachedFileName = selectedFile.name;
            this.#renderAttachedState();
        }
        catch (uploadError)
        {
            await DialogBox.alert("Could not attach that document", uploadError.message);
        }
    }

    #detachDocument()
    {
        // Only the LINK is dropped, not the uploaded document. The file remains
        // in the user's own source library, where the ordinary retention rules
        // and delete affordance apply to it — pretending "Remove" deleted it
        // would be a false promise about a file that is still stored.
        this.#informationSourceId = "";
        this.#attachedFileName = "";
        this.#renderAttachedState();
    }

    #renderAttachedState()
    {
        const attachedNameElement = this.#hostElement.querySelector('[data-role="attached-name"]');
        const detachButton = this.#hostElement.querySelector('[data-role="detach-document"]');
        const attachButton = this.#hostElement.querySelector('[data-role="attach-document"]');

        const bHasAttachment = this.#informationSourceId.length > 0;

        attachedNameElement.textContent = this.#attachedFileName;
        attachedNameElement.hidden = !bHasAttachment;
        detachButton.hidden = !bHasAttachment;
        attachButton.hidden = bHasAttachment;
    }

    static #pickFile()
    {
        return new Promise((resolve) =>
        {
            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.accept = ".pdf,.txt,.md,application/pdf,text/plain";

            fileInput.addEventListener("change", () =>
                resolve(fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null));

            // A cancelled picker fires no change event in most browsers, so the
            // promise would hang. 'cancel' is not universally supported either,
            // which is why both are wired rather than either alone.
            fileInput.addEventListener("cancel", () => resolve(null));

            fileInput.click();
        });
    }

    /**
     * Uploads through the ordinary information-source path, carrying the licence
     * declaration on the metadata so it lands on the stored row.
     *
     * PERMANENT retention is requested because a proof source that expires in
     * seven days is not proof. The retention HOLD is what actually protects it
     * once a correction cites it — this only avoids stamping a seven-day expiry
     * on a document in the window before that.
     */
    static async #uploadDocument(selectedFile, declaration)
    {
        const metadata =
        {
            name: selectedFile.name,
            mimeType: selectedFile.type || "application/octet-stream",
            sourceType: 0,
            retentionMode: 1,
            ocrMode: 0,
            licenceType: declaration.licenceType,
            licenceNote: declaration.licenceNote,
        };

        const formData = new FormData();
        formData.append("file", selectedFile);

        const response = await fetch(
            `${RefinementSourceAttachment.#UPLOAD_ENDPOINT}?metadata=${encodeURIComponent(JSON.stringify(metadata))}`,
            { method: "POST", body: formData },
        );

        if (!response.ok)
        {
            const errorJson = await response.json().catch(() => ({}));
            throw new Error(errorJson.detail || errorJson.error || `Upload failed (HTTP ${response.status}).`);
        }

        const responseJson = await response.json();

        if (!responseJson.informationSource || !responseJson.informationSource.id)
        {
            throw new Error("The upload succeeded but returned no source id.");
        }

        return responseJson.informationSource.id;
    }
}

export default RefinementSourceAttachment;
