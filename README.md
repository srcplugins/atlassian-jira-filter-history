# Filter History for Jira

[![Check](https://github.com/srcplugins/atlassian-jira-filter-history/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/srcplugins/atlassian-jira-filter-history/actions/workflows/check.yml?query=branch%3Amain)

**Version history for your Jira saved filters.**

Boards, dashboards and subscriptions rely on saved filters, but Jira only shows their current state. Filter History records changes to a filter's name, description, JQL and owner, including who made each change and when. Compare earlier versions and restore a filter when needed.

[Website](https://srcplugins.com/plugins/atlassian/filter-history-for-jira/)

## Features

- **See who changed a filter, and when.** Review the latest 100 recorded versions of a saved filter's name, description, JQL and owner, including who changed it and when. Open the history from **Apps → Filter History** or from Jira's search.
- **Compare versions.** See what changed between versions or compare an earlier version with the current filter, with added and removed text highlighted.
- **Restore earlier versions.** Restore a version's name, description and JQL after confirmation. Ownership, sharing and edit permissions stay unchanged, and the restore is recorded as a new version.
- **Recover deleted filters.** For 90 days after a filter is deleted, its last owner can review its history and recreate it from any recorded version as a new private filter.
- **Ask Rovo.** Ask the read-only **Filter History for Jira** agent about a filter's recent changes.

History starts when the app is installed; earlier changes aren't available. Sharing and edit-permission changes aren't recorded. Saved filters belong to the Jira site, not individual spaces, so the app works across all saved filters regardless of which spaces they search. No configuration is required.

For installation, usage, limits and troubleshooting, see the [website documentation](https://srcplugins.com/plugins/atlassian/filter-history-for-jira/).

## Changes to Jira

- **On install:** adds a **Filter History** page under **Apps**, a **Filter history** option in the apps menu of Jira's search and, where Rovo is available, the read-only **Filter History for Jira** agent. Existing filters, spaces and settings stay unchanged.
- **Restore version:** updates a filter's name, description and JQL as the current user, after confirmation. Jira must allow you to edit the filter. Ownership, sharing and edit permissions stay unchanged.
- **Recreate filter:** creates a new private filter owned by the current user, with the selected version's name, description and JQL, after confirmation. The new filter has a different ID, and boards, dashboards and subscriptions that used the deleted filter aren't updated.
- **Delete history:** permanently removes a filter's recorded versions and deletion record from the app's storage, without changing the filter in Jira.
- **On uninstall:** existing filters and Jira settings stay unchanged.

The app never deletes filters or changes their owners, sharing or edit permissions.

## Permissions

Everything runs as the current user, so Jira's normal visibility rules apply. You can view a filter's history only while Jira lets you see the filter, and restore a version only if Jira lets you edit it. A deleted filter's history is visible only to its last owner. Deleting histories needs **Administer Jira**. Jira administrators see every deleted filter's name, owner and deletion in the list, as Jira lets them manage private filters, but can't open its history.

| Scope                       | Purpose                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `read:jira-work`            | Find visible filters, read their current name, description and JQL, and check Jira administrator permissions. |
| `write:jira-work`           | Restore a filter's name, description and JQL or recreate a deleted filter as the current user.                |
| `manage:jira-configuration` | Receive filter creation, update and deletion events to record history.                                        |
| `storage:app`               | Store filter versions and deletion records.                                                                   |

## Subscription

Filter History for Jira is a paid app, billed through Atlassian, and works fully during a free trial. Without an active subscription, the **Filter History** page, Jira's search and the Rovo agent show no histories, and filters can't be restored or recreated; each says the site has no active subscription. Filter changes are still recorded, so the history has no gap, and nothing stored is deleted because of the subscription. Everything works again once the site subscribes in Atlassian Administration.

## Data

Atlassian Forge stores each recorded filter version's ID, name, description, JQL and owner, the account that made the change and when. For deleted filters, it also stores the filter's name, last owner, who deleted it and when. Sharing and edit permissions aren't recorded. Each filter keeps its latest 100 versions; older ones are removed as new ones are recorded. A deleted filter's history is removed 90 days after the deletion, unless its owner recreates the filter first, which moves the history to the new filter, or a Jira administrator deletes it sooner. Jira leaves descriptions over 10,000 characters out of its filter events, so such a version records that its description is missing and can't be restored or recreated.

The app does not send data outside Atlassian or log filter content. After uninstalling, Jira filters stay unchanged; Forge retains app data for 28 days, and reinstalling doesn't restore it automatically.

**Note:** A filter's history follows its current visibility. Sharing a filter also makes its earlier versions visible to the people you share it with, including names, descriptions and JQL from before it was shared. Rovo features are subject to [Atlassian's Rovo data policies](https://support.atlassian.com/rovo/docs/rovo-data-privacy-and-usage-guidelines/), which may include third-party models.

## Support

For questions, bug reports, or feature requests, email **support@srcplugins.com** or open an issue on [**GitHub**](https://github.com/srcplugins/atlassian-jira-filter-history/issues).

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).

Third-party components and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
