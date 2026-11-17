# A visual change sends one message per pull request, with the few changes that the eye sees

- Status: accepted
- Date: 2026-11-17

## Context

On 2026-11-17 the maintainer reported that the pictures of visual changes flooded the chat (#238). One pull request of Renovate, Dennis-Otto/paperless-sync#512, an update of the image of Nextcloud, brought *64 pictures look different* and albums of pictures that differed by 0.08 to 0.65 % of their pixels, each in one frame of an animation, in which nobody saw a difference. Each newer head of a pull request sent an album of its own, of as many pictures as fit into the ten photos of an album ([decision 0027](0027-the-album-of-a-visual-change-shows-one-comparison-per-picture.md)), and the release pull request, whose head moves with every merge, got a new message and a new album each time. The messages that needed the maintainer drowned.

What the comparison draws and what it counts as a change is the visual check's, in the blueprint (Dennis-Otto/repo-blueprint#985). This decision is about how much of it the pager sends.

## Options

1. **A threshold of the pager:** leave out a picture below a share of changed pixels, such as 1 %. The share can't tell noise from a change: the noise of paperless-sync#512 took up to 0.65 % of the pixels of a picture, and the real change of a screen of homedarts-for-autodarts#716 0.66 %. A threshold of the pager would hide real changes, and a second threshold beside the check's would disagree with it.
2. **The report decides what the eye sees, the pager decides how much it sends:** the report of the check says of each picture whether its change is above its threshold of sight, as `visible`, and the pager sends only those, few of them, once per pull request.
3. **Replace the album with each head:** edit the photos of the album in place with `editMessageMedia`, or delete it and send a new one. An album can't grow or shrink in place, a bot deletes no message older than 48 hours, and a new album is again a notification.

## Decision

Option 2:

- **One message per pull request.** A newer head edits it in place, quietly, with the newest numbers and the link to its check. The release pull request keeps the message of its pictures too, below its own message, and a newer head edits it.
- **One album per message, of the three largest changes that the eye sees.** A picture whose report says `"visible": false` never goes. A report that doesn't say, as every report did before Dennis-Otto/repo-blueprint#985, counts each picture that it names, for the reason of option 1; the limit of three keeps its album small. When the album went, a newer head says in the message that the album shows an earlier head. Only when no album went yet, such as after heads whose change nobody saw, the first head whose change the eye sees sends it. A message that is gone, such as with a topic that the maintainer deleted, goes anew with its album.
- **What nobody sees comes quietly, in one line:** *🖼 64 pictures differ by 0.65 % at most, which nobody sees*, with the link to the check, without an album.
- **A bot's pull request that merges by itself waits for no decision:** Renovate, Dependabot and the blueprint bot turn on GitHub's auto-merge when their checks may decide, so a pull request of a bot with `auto_merge` gets nothing in the chat, and its pictures stay in the report of its check. A pull request of a bot without auto-merge, such as a refresh of the lock files that waits for the maintainer, gets its pictures; so does every pull request of the maintainer.
- **A setting:** `PICTURES` in `wrangler.jsonc`, from `0`, no album, to `3`, the default, takes the album down for an instance.

## Consequences

A pull request costs one notification for its pictures, and one more at most for an album that comes after heads whose change nobody saw; a dependency update that merges by itself costs none. The album shows what changed, not everything that differs. The maintainer finds every picture in the report of the check, which the message links. Until a repository has the report with `visible`, its album still shows its three largest changes once per pull request; with it, the noise of a dependency update stays out of the chat.
