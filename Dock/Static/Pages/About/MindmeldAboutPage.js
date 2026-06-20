import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import MindmeldAboutComponent from "./Components/MindmeldAboutComponent.js";

class MindmeldAboutPage extends HTMLElement
{

    connectedCallback()
    {

        this.setAttribute("page", "");

        this.innerHTML = `
            <header-component></header-component>
            <mindmeld-about-component></mindmeld-about-component>
        `;

        HeaderComponent.setTitle("About");
    }
}

customElements.define("mindmeld-about-page", MindmeldAboutPage);
export default MindmeldAboutPage;