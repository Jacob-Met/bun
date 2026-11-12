use super::bun_test::{self, AddedInPhase};
use super::jest::{FileColumns as _, Jest};
use bun_jsc::JSGlobalObject;

/// Also true inside a hook that a preload registered, because a preload's `beforeAll` runs once for all test files.
#[unsafe(no_mangle)]
extern "C" fn JSMock__isInPreload(global: &JSGlobalObject) -> bool {
    let vm = global.bun_vm();
    if vm.is_in_preload {
        return true;
    }
    // The runner belongs to the main thread.
    if !vm.is_main_thread {
        return false;
    }
    let Some(buntest_strong) = bun_test::clone_active_strong() else {
        return false;
    };
    let buntest = buntest_strong.get();
    if buntest.phase != bun_test::Phase::Execution
        || buntest.execution.active_group_ref().is_none()
    {
        return false;
    }
    buntest
        .get_current_state_data()
        .entry(buntest)
        .is_some_and(|entry| entry.added_in_phase == AddedInPhase::Preload)
}

/// Whether `path` is the test file that loads or runs now. Never in a Worker: the runner belongs to the main thread.
#[unsafe(no_mangle)]
extern "C" fn JSMock__isTestFile(path: &bun_core::String) -> bool {
    let Some(runner) = Jest::runner() else { return false };
    let Some(buntest) = runner.bun_test_root.clone_active_file() else { return false };
    path.eql_utf8(runner.files.items_source()[buntest.get().file_id as usize].path.text)
}
