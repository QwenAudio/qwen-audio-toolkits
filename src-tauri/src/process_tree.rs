//! Lifecycle helpers for application-managed child process trees.

#[cfg(windows)]
use std::process::Stdio;
use std::{
    io,
    process::{Child, Command},
};

/// Places a Unix child in a new process group whose ID is the child's PID.
///
/// Non-Unix platforms retain std's root-child behavior as a compatibility fallback.
pub fn configure_command(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        command.process_group(0);
    }

    #[cfg(not(unix))]
    {
        let _ = command;
    }
}

/// Terminates an application-managed child and reaps its root process.
///
/// On Unix the child must have been started with [`configure_command`]. The helper signals the
/// negative root PID, which targets only that child's process group, polls for a bounded graceful
/// exit, and escalates the group to SIGKILL before reaping the root. A missing process group or an
/// already-exited child is a successful terminal state.
#[cfg(unix)]
pub fn terminate(child: &mut Child) -> io::Result<()> {
    let root_pid = child.id();
    let term_result = terminate_process_group(root_pid);

    if wait_for_child_exit(child, TERMINATE_GRACE_PERIOD)? {
        return finish_termination(term_result, Ok(()));
    }

    if let Err(error) = kill_process_group(root_pid) {
        if !already_exited(&error) {
            return Err(error);
        }
    }

    finish_termination(term_result, child.wait().map(|_| ()))
}

#[cfg(any(windows, test))]
fn should_run_windows_taskkill(root_exited: bool) -> bool {
    !root_exited
}

#[cfg(any(windows, test))]
fn combine_windows_termination_results(
    taskkill_result: io::Result<()>,
    root_exited: bool,
    fallback_result: io::Result<()>,
) -> io::Result<()> {
    if root_exited {
        Ok(())
    } else {
        finish_termination(taskkill_result, fallback_result)
    }
}

/// On Windows, `taskkill /T` terminates the managed root and its descendants before the root is
/// reaped. This mirrors the process-group cleanup performed on Unix.
#[cfg(windows)]
pub fn terminate(child: &mut Child) -> io::Result<()> {
    let root_exited = match child.try_wait() {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(error) if already_exited(&error) => true,
        Err(error) => return Err(error),
    };
    if !should_run_windows_taskkill(root_exited) {
        return Ok(());
    }

    let taskkill_result = terminate_process_tree(child.id());
    if wait_for_child_exit(child, TERMINATE_GRACE_PERIOD)? {
        return combine_windows_termination_results(taskkill_result, true, Ok(()));
    }

    let fallback_result = match child.kill() {
        Ok(()) => child.wait().map(|_| ()),
        Err(error) if already_exited(&error) => child.wait().map(|_| ()),
        Err(error) => Err(error),
    };
    combine_windows_termination_results(taskkill_result, false, fallback_result)
}

/// Unsupported non-Unix/non-Windows targets retain std's root-child behavior as a compatibility
/// fallback.
#[cfg(all(not(unix), not(windows)))]
pub fn terminate(child: &mut Child) -> io::Result<()> {
    let signal_result = child.kill();
    finish_termination(signal_result, child.wait().map(|_| ()))
}

#[cfg(any(windows, test))]
fn windows_taskkill_arguments(root_pid: u32) -> [String; 4] {
    [
        "/PID".to_owned(),
        root_pid.to_string(),
        "/T".to_owned(),
        "/F".to_owned(),
    ]
}

#[cfg(any(windows, test))]
fn taskkill_timeout_result(reap_result: io::Result<()>) -> io::Result<()> {
    reap_result?;
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "taskkill timed out while terminating the managed process tree",
    ))
}

#[cfg(windows)]
fn terminate_process_tree(root_pid: u32) -> io::Result<()> {
    let mut taskkill = Command::new("taskkill")
        .args(windows_taskkill_arguments(root_pid))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    if wait_for_child_exit(&mut taskkill, TASKKILL_TIMEOUT)? {
        let status = taskkill.wait()?;
        if status.success() {
            return Ok(());
        }
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!("taskkill exited with {status}"),
        ));
    }

    match taskkill.kill() {
        Ok(()) => taskkill_timeout_result(taskkill.wait().map(|_| ())),
        Err(error) if already_exited(&error) => {
            taskkill_timeout_result(taskkill.wait().map(|_| ()))
        }
        Err(error) => {
            taskkill.wait()?;
            Err(error)
        }
    }
}

#[cfg(any(unix, windows))]
const TERMINATE_GRACE_PERIOD: std::time::Duration = std::time::Duration::from_millis(250);
#[cfg(windows)]
const TASKKILL_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(250);
#[cfg(any(unix, windows))]
const TERMINATE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);

#[cfg(any(unix, windows))]
fn wait_for_child_exit(child: &mut Child, timeout: std::time::Duration) -> io::Result<bool> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(true),
            Ok(None) => {}
            Err(error) if already_exited(&error) => return Ok(true),
            Err(error) => return Err(error),
        }

        let now = std::time::Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        std::thread::sleep(TERMINATE_POLL_INTERVAL.min(deadline - now));
    }
}

fn finish_termination(
    signal_result: io::Result<()>,
    reap_result: io::Result<()>,
) -> io::Result<()> {
    match signal_result {
        Err(error) if !already_exited(&error) => Err(error),
        _ => match reap_result {
            Err(error) if !already_exited(&error) => Err(error),
            _ => Ok(()),
        },
    }
}

fn already_exited(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || {
        #[cfg(unix)]
        {
            error.raw_os_error() == Some(libc::ESRCH)
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
}

#[cfg(unix)]
pub(crate) fn terminate_process_group(root_pid: u32) -> io::Result<()> {
    signal_process_group(root_pid, libc::SIGTERM)
}

/// Forcefully terminates the process group previously created by [`configure_command`].
///
/// This is the bounded-cleanup escalation after a graceful SIGTERM wait expires.
#[cfg(unix)]
pub(crate) fn kill_process_group(root_pid: u32) -> io::Result<()> {
    signal_process_group(root_pid, libc::SIGKILL)
}

#[cfg(unix)]
fn signal_process_group(root_pid: u32, signal: libc::c_int) -> io::Result<()> {
    let root_pid = libc::pid_t::try_from(root_pid).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "managed child PID does not fit the platform pid_t",
        )
    })?;
    if root_pid <= 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "managed child PID must be positive",
        ));
    }
    let process_group = root_pid.checked_neg().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "managed child PID cannot identify a process group",
        )
    })?;

    let result = unsafe { libc::kill(process_group, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod windows_contract_tests {
    use super::*;

    #[test]
    fn windows_taskkill_arguments_target_and_force_the_managed_tree() {
        assert_eq!(
            windows_taskkill_arguments(4_242),
            ["/PID", "4242", "/T", "/F"]
        );
    }

    #[test]
    fn windows_termination_skips_taskkill_for_an_exited_root() {
        assert!(!should_run_windows_taskkill(true));
        assert!(should_run_windows_taskkill(false));
    }

    #[test]
    fn windows_termination_ignores_taskkill_failure_after_root_exit() {
        let taskkill_error = io::Error::other("taskkill failed after the root exited");
        assert!(
            combine_windows_termination_results(Err(taskkill_error), true, Ok(())).is_ok(),
            "a root observed exited during the grace poll is a successful race outcome"
        );
    }

    #[test]
    fn windows_termination_preserves_taskkill_failure_for_a_running_root() {
        let taskkill_error = io::Error::other("taskkill failed while the root was running");
        let error = combine_windows_termination_results(Err(taskkill_error), false, Ok(()))
            .expect_err("a taskkill failure still matters when fallback cleanup was needed");
        assert_eq!(error.kind(), io::ErrorKind::Other);
    }

    #[test]
    fn taskkill_timeout_is_reported_only_after_reaping() {
        let error = taskkill_timeout_result(Ok(()))
            .expect_err("a reaped taskkill process must report its timeout");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn taskkill_timeout_preserves_a_reaping_failure() {
        let error = taskkill_timeout_result(Err(io::Error::other("taskkill reap failed")))
            .expect_err("a taskkill reaping failure must not be hidden by a timeout");
        assert_eq!(error.kind(), io::ErrorKind::Other);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        io::BufRead,
        process::Stdio,
        thread,
        time::{Duration, Instant},
    };

    const PROCESS_REMOVAL_TIMEOUT: Duration = Duration::from_secs(2);

    struct ProcessTreeFixture {
        child: Child,
        root_pid: libc::pid_t,
        descendant_pid: libc::pid_t,
        cleanup_needed: bool,
    }

    impl Drop for ProcessTreeFixture {
        fn drop(&mut self) {
            if self.cleanup_needed {
                let _ = unsafe { libc::kill(-self.root_pid, libc::SIGKILL) };
                let _ = self.child.wait();
            }
        }
    }

    fn process_exists(pid: libc::pid_t) -> bool {
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + PROCESS_REMOVAL_TIMEOUT;
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        condition()
    }

    fn spawn_term_ignoring_process_tree() -> ProcessTreeFixture {
        let mut command = Command::new("sh");
        command
            .args([
                "-c",
                "trap '' TERM; (trap '' TERM; sleep 2) & descendant=$!; printf '%s\\n' \"$descendant\"; wait \"$descendant\"",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        configure_command(&mut command);
        let mut child = command.spawn().expect("spawn TERM-ignoring process tree");
        let root_pid = libc::pid_t::try_from(child.id()).expect("root PID fits pid_t");
        let stdout = child.stdout.take().expect("fixture stdout");
        let mut reader = std::io::BufReader::new(stdout);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .expect("read descendant PID from fixture");
        let descendant_pid = line
            .trim()
            .parse::<libc::pid_t>()
            .expect("descendant PID is valid");
        ProcessTreeFixture {
            child,
            root_pid,
            descendant_pid,
            cleanup_needed: true,
        }
    }

    #[test]
    fn terminate_escalates_term_ignoring_process_group_and_reaps_root() {
        let mut fixture = spawn_term_ignoring_process_tree();
        let started = Instant::now();

        terminate(&mut fixture.child).expect("terminate TERM-ignoring process tree");

        assert!(
            started.elapsed() < Duration::from_secs(1),
            "termination must escalate instead of waiting for SIGTERM-ignoring root"
        );
        assert!(
            fixture
                .child
                .try_wait()
                .expect("inspect reaped root")
                .is_some(),
            "root must be reaped"
        );
        assert!(
            !process_exists(fixture.root_pid),
            "root process must be removed"
        );
        assert!(
            wait_until(|| !process_exists(fixture.descendant_pid)),
            "descendant process must be removed"
        );
        fixture.cleanup_needed = false;
    }
}
