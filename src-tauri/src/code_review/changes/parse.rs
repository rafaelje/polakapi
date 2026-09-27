use std::collections::HashMap;

use super::{ChangeGroup, ChangeStatus};
use crate::code_review::git::{lossy, nul_records};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StatusEntry {
    pub path: String,
    pub original_path: Option<String>,
    pub group: ChangeGroup,
    pub status: ChangeStatus,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(in crate::code_review) struct LineCounts {
    pub insertions: u32,
    pub deletions: u32,
    pub binary: bool,
}

const CONFLICT_CODES: [&[u8; 2]; 7] = [b"DD", b"AU", b"UD", b"UA", b"DU", b"AA", b"UU"];

pub(super) fn parse_porcelain_z(raw: &[u8]) -> Vec<StatusEntry> {
    let mut records = nul_records(raw);
    let mut entries = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let (x, y) = (record[0], record[1]);
        let path = lossy(&record[3..]);
        let original = if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            records.next().map(lossy)
        } else {
            None
        };
        if CONFLICT_CODES
            .iter()
            .any(|code| code[0] == x && code[1] == y)
        {
            entries.push(entry(
                path,
                None,
                ChangeGroup::Unstaged,
                ChangeStatus::Conflicted,
            ));
            continue;
        }
        match (x, y) {
            (b'?', b'?') => {
                entries.push(entry(
                    path,
                    None,
                    ChangeGroup::Untracked,
                    ChangeStatus::Untracked,
                ));
                continue;
            }
            (b'!', b'!') => continue,
            _ => {}
        }
        for (code, group) in [(x, ChangeGroup::Staged), (y, ChangeGroup::Unstaged)] {
            if code == b' ' {
                continue;
            }
            let status = status_for(code);
            let source = match status {
                ChangeStatus::Renamed => original.clone(),
                _ => None,
            };
            entries.push(entry(path.clone(), source, group, status));
        }
    }
    entries
}

pub(in crate::code_review) fn parse_numstat_z(raw: &[u8]) -> HashMap<String, LineCounts> {
    let mut records = raw.split(|byte| *byte == 0);
    let mut counts = HashMap::new();
    while let Some(record) = records.next() {
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        let (Some(ins), Some(del), Some(path)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            let _original = records.next();
            match records.next() {
                Some(target) => lossy(target),
                None => continue,
            }
        } else {
            lossy(path)
        };
        let binary = ins == b"-" && del == b"-";
        counts.insert(
            path,
            LineCounts {
                insertions: parse_count(ins),
                deletions: parse_count(del),
                binary,
            },
        );
    }
    counts
}

pub(super) fn count_text_lines(content: &[u8]) -> LineCounts {
    let sniff = &content[..content.len().min(8000)];
    if sniff.contains(&0) {
        return LineCounts {
            binary: true,
            ..LineCounts::default()
        };
    }
    let newlines = content.iter().filter(|byte| **byte == b'\n').count();
    let trailing = usize::from(content.last().is_some_and(|byte| *byte != b'\n'));
    LineCounts {
        insertions: u32::try_from(newlines + trailing).unwrap_or(u32::MAX),
        ..LineCounts::default()
    }
}

fn entry(
    path: String,
    original_path: Option<String>,
    group: ChangeGroup,
    status: ChangeStatus,
) -> StatusEntry {
    StatusEntry {
        path,
        original_path,
        group,
        status,
    }
}

fn status_for(code: u8) -> ChangeStatus {
    match code {
        b'A' | b'C' => ChangeStatus::Added,
        b'D' => ChangeStatus::Deleted,
        b'R' => ChangeStatus::Renamed,
        _ => ChangeStatus::Modified,
    }
}

fn parse_count(raw: &[u8]) -> u32 {
    std::str::from_utf8(raw)
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(0)
}
