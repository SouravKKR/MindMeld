/**
 * Event names dispatched by PageNavigator and listened to by pages that
 * need to react to navigation actions originating outside their own DOM.
 *
 * HARDWARE_BACK_AT_ROOT fires when the user presses the browser / Android /
 * Tauri back button AND PageNavigator has nothing left to pop. The bottom-
 * of-stack page (usually HomePage) decides what "back" means in that
 * context — for HomePage it's "go up one deck level".
 *
 * PAGE_OPENED fires once per page transition (open / back / clearAndOpen)
 * with `detail.pageTagName` set to the now-active page's custom-element
 * tag. The tutorial engine uses it to detect unexpected navigations and
 * abort + restart cleanly instead of leaving an orphaned spotlight.
 */
class NavigationEvents
{
    static HARDWARE_BACK_AT_ROOT = "hardware-back-at-root";
    static PAGE_OPENED           = "page-opened";
}

export default NavigationEvents;
