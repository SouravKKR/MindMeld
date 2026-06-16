// Window CustomEvent names for the maintenance subsystem. MaintenanceStatusPoller
// dispatches STATUS_UPDATED whenever it refreshes; the MaintenanceBanner listens
// for it. Mirrors the other event-name maps in Main/Globals/Events/.

class MaintenanceEvents
{
    static STATUS_UPDATED = "maintenance-status-updated";
}

export default MaintenanceEvents;
