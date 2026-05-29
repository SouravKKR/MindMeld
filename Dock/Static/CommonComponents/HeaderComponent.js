import PageNavigator from "../Globals/Classes/PageNavigator.js";
import OptionsSidebar from "./OptionsSidebar.js";

class HeaderComponent extends HTMLElement
{
    static setTitle(title)
    {
        const currentPage = PageNavigator.getCurrentPage();
        const headerComponent = currentPage.querySelector("header-component");
        headerComponent.setAttribute("title", title);
        headerComponent.render();
    }

    render()
    {
        this.innerHTML = 
        `

            <h1 align="center">${this.getAttribute("title")}</h1>
            <button class="options-button">
                <img src="./Globals/Assets/Images/Icons/MenuIcon.svg" alt="Menu Icon">
            </button>   
            <button class="back-button">
                <img src="./Globals/Assets/Images/Icons/BackIcon.svg" alt="Back Icon">
            </button> 
        `;

        const optionsButton = this.querySelector(".options-button");
        const backButton = this.querySelector(".back-button");



        optionsButton.addEventListener("click", (event) => 
        {
            event.stopPropagation();
            OptionsSidebar.toggle();
        });

        backButton.addEventListener("click", (event) => 
        {
            event.stopPropagation();
            PageNavigator.back();
        });

        // This is done because of circular dependency. 
        // The header component is rendered before the page navigator loads. 
        requestAnimationFrame(()=>
        {
            if(!(PageNavigator.canGoBack()))
            {
                backButton.style.display = "none";
            }
        });
    }

    connectedCallback()
    {
        this.render();
    }
}

customElements.define("header-component", HeaderComponent);
export default HeaderComponent;