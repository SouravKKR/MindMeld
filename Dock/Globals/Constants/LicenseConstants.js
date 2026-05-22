class LicenseConstants
{
    static MAX_DEVICES_PER_USER = 4;
    static OFFLINE_GRACE_DAYS_FOR_DEVICE_SIGNOUT = 7;
    static KEY_ROTATION_INTERVAL_DAYS = 7;
    static OFFLINE_SESSION_HARD_EXPIRY_DAYS = 30;
    static HEARTBEAT_INTERVAL_MILLISECONDS = 300000;
}

module.exports = LicenseConstants;
