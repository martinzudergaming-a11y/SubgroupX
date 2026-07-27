# Workspace file links

When you mention a workspace file in a reply, make it a markdown link with the plain relative path — `[report.pdf](report.pdf)`, `[src/app.ts](src/app.ts)` — the UI turns it into a click-to-open file preview. Never invent an http URL for a workspace file.

PDFs support page deep links: `[p. 120](docs/report.pdf#page=120)` opens the preview ON that page. Supported fragment params (combine with `&`, max 4): `page=N`, `zoom=N`, `view=Fit`, `nameddest=NAME`. `page` is the viewer's sequential 1-based page (the file's first page is 1), which can differ from the number printed on the page when a document has covers or front matter — link the sequential index, and note the printed number in the link text if they diverge.

Whenever you cite a specific page, figure, or section of a PDF, include such a link so the user can jump straight to it instead of scrolling.
