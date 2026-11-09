<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Local project knowledge map

For feature planning, debugging, architecture, and dependency questions, use the local Graphify map before broad source searches:

```powershell
& 'D:\Obsidian\Tools\graphify-env\Scripts\python.exe' -X utf8 'D:\Obsidian\ExamProctor-Graph\project_map.py' query 'relevant symbol or feature keywords' --budget 1000
```

The helper checks source content and rebuilds an outdated map locally. Use concise keywords or known symbol names; `explain`, `affected`, and `path` are also supported. Read the identified files in this project before editing. Graph paths are project-relative; the reference snapshot is not the working source. Dynamic RPC calls, runtime behavior, and unsupported files need targeted source searches when graph results are incomplete. Avoid loading the full graph JSON, report, or vault into context. For a small edit with a known file, read that file directly.

After finishing code or schema changes, run the helper with `refresh` instead of `query` and no question. It skips rebuilding when indexed content is unchanged and updates the Obsidian Code Map when needed. If the helper or D: paths are unavailable, continue with targeted source searches and mention the map limitation briefly. Never add credentials or runtime student data to the map. Personal vault notes stay outside `Code Map`.
