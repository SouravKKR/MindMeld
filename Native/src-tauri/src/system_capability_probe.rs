//! What this device can actually do, reported as facts.
//!
//! Deliberately decides nothing. The frontend's model selector already owns
//! every judgement about which model suits which hardware, driven by the shared
//! catalogue, and it is pure and testable precisely because it is fed a
//! description rather than a verdict. Adding a second opinion here would give
//! the same question two answers that could disagree.

use serde::Serialize;
use sysinfo::System;

/// Mirrors the shape the frontend's driver contract expects from
/// `probeCapability()`. Serialised camelCase because it crosses into
/// JavaScript, where snake_case field names would read as a foreign object.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCapability
{
    pub total_memory_megabytes: u64,
    pub available_memory_megabytes: u64,
    pub logical_core_count: usize,
    pub b_mobile_device: bool,
    pub acceleration_label: String,
    pub b_inference_compiled_in: bool,
}

pub struct SystemCapabilityProbe;

impl SystemCapabilityProbe
{
    /// Total physical memory, cores, and how this build would run a model.
    ///
    /// `available_memory_megabytes` is reported alongside the total because
    /// they answer different questions: the total says which model this device
    /// could ever run, while the available says whether loading one right now
    /// would push the system into swap. A phone with 8 GB installed and 900 MB
    /// free cannot load a gigabyte of weights, and only the second figure shows
    /// that.
    pub fn probe() -> SystemCapability
    {
        let mut system = System::new();
        system.refresh_memory();

        // sysinfo reports bytes; the frontend's catalogue thresholds are in
        // megabytes, so the conversion happens once, here, rather than at each
        // comparison.
        const BYTES_PER_MEGABYTE: u64 = 1024 * 1024;

        SystemCapability
        {
            total_memory_megabytes: system.total_memory() / BYTES_PER_MEGABYTE,
            available_memory_megabytes: system.available_memory() / BYTES_PER_MEGABYTE,
            logical_core_count: Self::resolve_logical_core_count(),
            b_mobile_device: Self::is_mobile_target(),
            acceleration_label: Self::resolve_acceleration_label().to_string(),
            b_inference_compiled_in: cfg!(feature = "native-inference"),
        }
    }

    /// The number of threads worth using for inference.
    ///
    /// `available_parallelism` respects container and affinity limits, which a
    /// raw core count does not — oversubscribing a throttled environment makes
    /// generation slower, not faster.
    fn resolve_logical_core_count() -> usize
    {
        std::thread::available_parallelism()
            .map(|parallelism| parallelism.get())
            .unwrap_or(1)
    }

    fn is_mobile_target() -> bool
    {
        cfg!(any(target_os = "android", target_os = "ios"))
    }

    /// How this build was compiled to run the model.
    ///
    /// A compile-time fact, not a runtime probe: the backend is chosen when the
    /// inference library is built, so asking the hardware at run time would
    /// report a capability this binary cannot use.
    ///
    /// Android reports the processor even where the device has a capable GPU.
    /// That is the intended configuration: mobile GPU compute for this model
    /// size measures worse than the processor's own vector units, and enabling
    /// it would also drag a shader toolchain into the build for a slowdown.
    fn resolve_acceleration_label() -> &'static str
    {
        if !cfg!(feature = "native-inference")
        {
            return "none";
        }
        if cfg!(target_os = "android")
        {
            return "processor";
        }
        if cfg!(any(target_os = "macos", target_os = "ios"))
        {
            return "metal";
        }
        "processor"
    }
}


#[cfg(test)]
mod tests
{
    use super::*;

    #[test]
    fn reports_a_plausible_machine()
    {
        let capability = SystemCapabilityProbe::probe();

        // Any machine able to run this test has memory and at least one core.
        // Asserting non-zero is what catches a unit mix-up (bytes reported as
        // megabytes, or a division applied twice), which is otherwise invisible
        // until a model is silently judged too large for every device.
        assert!(capability.total_memory_megabytes > 0, "total memory should be reported");
        assert!(capability.logical_core_count >= 1, "at least one core should be reported");
    }

    #[test]
    fn desktop_builds_are_not_reported_as_mobile()
    {
        if cfg!(any(target_os = "android", target_os = "ios"))
        {
            return;
        }
        assert!(!SystemCapabilityProbe::probe().b_mobile_device);
    }
}
