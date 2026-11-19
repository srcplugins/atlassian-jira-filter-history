# Changelog

User-facing changes in each released version of Filter History for Jira.

## 1.0.1 (unreleased)

- Documentation: the README says history is kept with no time limit while the filter exists, that only the time is kept when an administrator deletes a deleted filter's history, and that the app keeps a list of the account IDs it stores for Atlassian's personal data report.

## 1.0.0

- First release: a version history of each saved filter's name, description, JQL and owner, recorded from install, with who changed it and when.
- Compare a version with the one before it or with the filter now, and restore its name, description and JQL.
- Open a filter's history from **Apps → Filter History** or from the apps menu in Jira's search.
- A deleted filter's history stays with its last owner, who can recreate the filter from any version. Jira administrators can delete histories; a filter's history then shows who deleted it and when.
- Jira administrators see the history of every filter, including private and deleted ones, and restore only filters Jira lets them edit.
- A read-only Rovo agent answers what changed in a filter.
- Each week the app reports the account IDs it stores to Atlassian, and removes a closed account's ID from its history.
- A paid app, billed through Atlassian, with a free trial. Without an active subscription, histories can't be viewed, filters can't be restored or recreated and changes aren't recorded; nothing stored is lost. The weekly report, closed-account removal and 90-day cleanup continue.
