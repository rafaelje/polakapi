mod branch;
mod changes;
mod commit;
mod contents;
mod discard;
mod git;
mod paths;
mod processes;
mod refs;
mod review_folder;
mod staging;
mod sync;
mod verdict;
mod watch;

#[cfg(test)]
mod test_repo;

#[cfg(test)]
mod remote_fixture;

pub use branch::{code_review_branch, code_review_default_base};
pub use changes::code_review_changes;
pub use commit::code_review_commit;
pub use contents::code_review_file_contents;
pub use discard::code_review_discard;
pub use processes::code_review_processes;
pub use refs::code_review_refs;
pub use review_folder::code_review_prepare_review;
pub use staging::{code_review_stage, code_review_stage_all, code_review_unstage};
pub use sync::{code_review_pull, code_review_switch_branch};
pub use watch::{code_review_watch_start, CodeReviewWatchers};

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|error| format!("join error: {error}"))?
}
