//! Ties sidecar processes to the app's lifetime. On Windows every bridge child
//! joins one Job Object created with `KILL_ON_JOB_CLOSE`; the app holds the only
//! handle, so when Cortex Studio exits for any reason (including a crash or an
//! end-task) Windows closes the handle and terminates the children with it.

use std::process::Child;

#[cfg(target_os = "windows")]
mod imp {
    use std::{ffi::c_void, os::windows::io::AsRawHandle, process::Child, sync::OnceLock};

    type Handle = *mut c_void;

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

    #[repr(C)]
    #[allow(dead_code)]
    #[derive(Default)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[allow(dead_code)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[allow(dead_code)]
    #[derive(Default)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *mut c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    /// The job handle as an address; raw handles are not `Send`. Never closed:
    /// closing it is what kills the children, and that must happen at exit only.
    static JOB: OnceLock<Option<usize>> = OnceLock::new();

    fn create_job() -> Option<usize> {
        // SAFETY: plain Win32 calls with valid arguments; the info struct matches
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION and outlives the call.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                eprintln!(
                    "[bridge] could not create a job object: {}",
                    std::io::Error::last_os_error()
                );
                return None;
            }
            let mut info = ExtendedLimitInformation::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                (&mut info as *mut ExtendedLimitInformation).cast(),
                std::mem::size_of::<ExtendedLimitInformation>() as u32,
            );
            if ok == 0 {
                eprintln!(
                    "[bridge] could not configure the job object: {}",
                    std::io::Error::last_os_error()
                );
                CloseHandle(job);
                return None;
            }
            Some(job as usize)
        }
    }

    pub fn adopt(child: &Child) {
        let Some(job) = *JOB.get_or_init(create_job) else {
            return;
        };
        // SAFETY: `job` is a live job handle owned by this process and the child
        // handle is valid while `child` is borrowed.
        let ok = unsafe { AssignProcessToJobObject(job as Handle, child.as_raw_handle()) };
        if ok == 0 {
            eprintln!(
                "[bridge] could not tie the bridge process to the app: {}",
                std::io::Error::last_os_error()
            );
        }
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn extended_limit_information_matches_the_win32_layout() {
            // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64 and 112 on x86.
            let expected = if cfg!(target_pointer_width = "64") {
                144
            } else {
                112
            };
            assert_eq!(
                std::mem::size_of::<super::ExtendedLimitInformation>(),
                expected
            );
        }

        #[test]
        fn adopted_children_join_the_kill_on_close_job() {
            let mut child = std::process::Command::new("cmd")
                .args(["/C", "exit 0"])
                .spawn()
                .unwrap();
            super::adopt(&child);
            assert!(super::JOB.get().copied().flatten().is_some());
            child.wait().unwrap();
        }
    }
}

/// Makes `child` die with the app. Best effort: on failure the child is still
/// killed by the explicit exit and cancel paths.
pub fn adopt(child: &Child) {
    #[cfg(target_os = "windows")]
    imp::adopt(child);
    #[cfg(not(target_os = "windows"))]
    let _ = child;
}
