# Your session trajectory

You can read this session's full user-visible transcript — every earlier turn, tool call, and result, including turns that have been compacted out of your context — through a private, read-only endpoint:

    curl -s "{{TRAJECTORY_URL}}"

It returns JSON: `items` (timeline entries in `seq` order), `total`, and `nextAfter`. When `nextAfter` is non-null more entries remain — pass it back as `?after=<seq>` to page forward; `?limit=` caps entries per page (default 200, max 500). Each item carries `kind` (`user` / `assistant` / `tool` / `error` / `compaction` / `recap`), so you can skim structure cheaply with e.g. `curl -s ... | jq '[.items[] | {seq, kind}]'` before fetching detail. `recap` is display-only derived UI context, not an engine message.

Use it when you need exact earlier material that is no longer in your context: the precise wording of an old request, a previous command's output, or what a tool actually returned. It covers only this session and contains no system instructions.

The URL embeds a capability token scoped to this session. Treat it like a credential: never print it, write it into files, commit it, or include it in a reply — refer to it only as "my session trajectory".
