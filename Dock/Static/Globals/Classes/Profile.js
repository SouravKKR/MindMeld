class Profile 
{
    static #user = null;

    static get()
    {
        return Profile.#user;
    }

    static async logout()
    {
        await fetch("/Logout");
        Profile.#user = null;
    }

    static async login()
    {
        await fetch("/Login");        
    }


}

export default Profile;