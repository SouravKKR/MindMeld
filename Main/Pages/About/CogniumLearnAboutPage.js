import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import CogniumLearnAboutComponent from "./Components/CogniumLearnAboutComponent.js";

class CogniumLearnAboutPage extends HTMLElement
{

    connectedCallback()
    {

        this.setAttribute("page", "");

        this.innerHTML = `
            <header-component></header-component>
            <cogniumlearn-about-component></cogniumlearn-about-component>
        `;

        HeaderComponent.setTitle("About");
    }
}

customElements.define("cogniumlearn-about-page", CogniumLearnAboutPage);
export default CogniumLearnAboutPage;