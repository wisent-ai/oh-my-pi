//! Windows process handles: duplication for safe termination, liveness and
//! termination by handle or by process id.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};

use crate::sys;

pub(super) fn duplicate_handle(handle: RawHandle) -> Option<OwnedHandle> {
	use windows_sys::Win32::{
		Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle},
		System::Threading::GetCurrentProcess,
	};

	// SAFETY: GetCurrentProcess returns a pseudo-handle for the current process
	// and has no preconditions.
	let current = unsafe { GetCurrentProcess() };
	let mut out_handle = std::ptr::null_mut();
	// SAFETY: `current` is a valid current-process pseudo-handle, `handle` is
	// an OS process handle owned by Tokio's child process object, and
	// `out_handle` is a valid out pointer checked below before ownership is
	// transferred to OwnedHandle.
	let ok = unsafe {
		DuplicateHandle(
			current,
			handle,
			current,
			&mut out_handle,
			0,
			0,
			DUPLICATE_SAME_ACCESS,
		)
	};
	if ok == 0 || out_handle.is_null() {
		return None;
	}

	// SAFETY: DuplicateHandle succeeded and returned a non-null owned duplicate
	// in `out_handle`, so transferring ownership to OwnedHandle is valid.
	Some(unsafe { OwnedHandle::from_raw_handle(out_handle) })
}

pub(super) fn terminate_raw_handle(handle: RawHandle) -> bool {
	use windows_sys::Win32::System::Threading::TerminateProcess;

	// SAFETY: The caller provides a process handle opened/duplicated for process
	// termination. The handle remains owned by its original owner.
	unsafe { TerminateProcess(handle, 1) != 0 }
}

/// Checks whether a duplicated Windows process handle still refers to a running process.
#[must_use]
pub fn process_handle_is_running(handle: &OwnedHandle) -> bool {
	use windows_sys::Win32::{
		Foundation::WAIT_TIMEOUT,
		System::Threading::WaitForSingleObject,
	};

	// SAFETY: `handle` is a live duplicated process handle with synchronization access.
	unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) == WAIT_TIMEOUT }
}

/// Terminates the process referenced by a duplicated Windows process handle.
#[must_use]
pub fn terminate_process_handle(handle: &OwnedHandle) -> bool {
	terminate_raw_handle(handle.as_raw_handle())
}

pub(super) fn terminate_process_id(pid: sys::process::ProcessId) -> bool {
	use windows_sys::Win32::Foundation::CloseHandle;
	use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE};

	let Ok(pid) = u32::try_from(pid) else {
		return false;
	};

	// SAFETY: OpenProcess is called with PROCESS_TERMINATE for a numeric process id.
	// A null handle is handled below.
	let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
	if handle.is_null() {
		return false;
	}

	let terminated = terminate_raw_handle(handle);
	// SAFETY: The handle was returned by OpenProcess and is closed exactly once here.
	let _close_result = unsafe { CloseHandle(handle) };
	terminated
}
