# Filter History for Jira

[![Check](https://github.com/srcplugins/atlassian-jira-filter-history/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/srcplugins/atlassian-jira-filter-history/actions/workflows/check.yml?query=branch%3Amain)

**Version history for your Jira saved filters.**

Keep a version history of your Jira saved filters. Track changes, compare previous versions, and restore a filter when something goes wrong.

[Website](https://srcplugins.com/plugins/atlassian/filter-history-for-jira/)

## Features

- **Track filter changes.** Review the latest 100 versions of each saved filter, including changes to its name, description, JQL and owner, with who made each change and when. Open the history from **Apps → Filter History** or from Jira's search.
- **Compare versions.** See what changed between versions or compare an earlier version with the current filter, with added and removed text highlighted.
- **Restore previous versions.** Restore a version's name, description and JQL after confirmation. Ownership, sharing and edit permissions stay unchanged, and the restore is recorded as a new version.
- **Recover deleted filters.** For 90 days after a filter with recorded history is deleted, its last owner can review that history and recreate the filter from any recorded version as a new private filter.
- **Ask Rovo.** Ask the read-only **Filter History for Jira** agent about a filter's recent changes.

Sharing and edit-permission changes aren't recorded. No configuration is required.

For installation, usage, limits and troubleshooting, see the [website documentation](https://srcplugins.com/plugins/atlassian/filter-history-for-jira/).

## Changes to Jira

- **Installation:** adds a **Filter History** page under **Apps**, a **Filter History** option in the apps menu of Jira's search and, where Rovo is available, the read-only **Filter History for Jira** agent. Existing filters, spaces and settings stay unchanged.
- **Restore version:** updates a filter's name, description and JQL as the current user. Jira must allow you to edit the filter. Ownership, sharing and edit permissions stay unchanged.
- **Recreate filter:** creates a new private filter owned by the current user, with the selected version's name, description and JQL. The new filter has a different ID, and boards, dashboards and subscriptions that used the deleted filter aren't updated.
- **Delete history:** permanently removes a filter's recorded versions and deletion record from the app's storage, without changing the filter in Jira. For a deleted filter, only the time of its delete stays, until 90 days after it. For a filter that still exists, its history then shows who deleted the earlier history and when.
- **Uninstallation:** existing filters and Jira settings stay unchanged.

The app never deletes filters or changes their owners, sharing or edit permissions.

## Permissions

Filter reads, restores and recreations respect Jira's user permissions. You can view history only for filters you can access and restore versions only for filters you can edit. A deleted filter's history is visible only to its last owner. Deleting histories requires the **Administer Jira** permission. Jira administrators can see all deleted filters and their deletion details, and permanently delete histories, but they cannot view another owner's deleted filter history.

| Scope | Purpose |
| --- | --- |
| `read:jira-work` | Find accessible filters, read their names, descriptions and JQL, and check administrator permissions. |
| `write:jira-work` | Restore previous filter versions or recreate deleted filters as the current user. |
| `manage:jira-configuration` | Receive filter events to record changes and deletions. |
| `storage:app` | Store filter histories and deletion records. |

## Subscription

Filter History for Jira is a paid app, billed through Atlassian, with full functionality during a free trial.

Without an active subscription, histories cannot be viewed, restored or recreated, and new changes are not recorded. Existing history is preserved and becomes available again when the subscription resumes.

## Data

Filter History stores each recorded version's filter ID, name, description, JQL, owner, and who changed it and when in Atlassian Forge. Deleted filter records also include the last owner, who deleted the filter, and when. When an administrator deletes a filter's history, the app keeps who deleted it and when. Sharing and edit permissions are not recorded.

Each filter retains its latest 100 versions. Deleted filter histories are removed from 90 days after the delete, unless the filter is recreated or an administrator deletes the history sooner. Descriptions over 10,000 characters cannot be recorded or restored due to Jira API limitations.

The app declares no external network access and does not log filter content. Uninstalling leaves Jira filters unchanged. Forge retains app data for 28 days after uninstall, but reinstalling does not automatically restore it.

**Privacy note:** Filter history follows the filter's current visibility. Anyone you share a filter with can view its earlier versions, including names, descriptions and JQL from before it was shared. Review history before sharing.

When you ask the Rovo agent about a filter you can see, it receives the filter's ID and name, its latest ten versions (when, who, what changed, and the name, description, JQL and owner after each change) and, if an administrator deleted earlier history, who did and when. Rovo requests and responses are processed under [Atlassian's Rovo data policies](https://support.atlassian.com/rovo/docs/rovo-data-privacy-and-usage-guidelines/), potentially using third-party AI models.

## Support

For questions, bug reports, or feature requests, email **support@srcplugins.com** or open an issue on [**GitHub**](https://github.com/srcplugins/atlassian-jira-filter-history/issues).

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).

Third-party components and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
