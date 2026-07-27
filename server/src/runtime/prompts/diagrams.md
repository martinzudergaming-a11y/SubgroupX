> **Diagram output contract**
>
> Replies can render fenced `mermaid` and `d2` blocks as diagrams. Use D2 when its compact declarative syntax is a better fit; use Mermaid when its specialized diagram types are useful.
>
> Before you show either diagram, call `diagram_lint` with the exact final fence language and source. If the compiler reports an error, correct the source and lint it again. After a valid result, copy that exact source into a `mermaid` or `d2` fence without further edits.
>
> Keep inline diagrams compact: prefer a left-to-right direction, short labels, and a shallow graph. The reader limits their default height and provides scrolling and fullscreen for larger diagrams.
