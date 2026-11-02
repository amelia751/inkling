# Text spans (`studio.text-spans`)

Named-entity and phrase labelling on plain-text documents. Spans are a module geometry,
`studio.text-spans.span` (`{ start, end, text }`, character offsets, end exclusive), so
the core never needed to know about text. Written against the public module contract only:
the one change outside this folder is its line in `apps/web/src/extension-host/bundled.ts`.

```json
{
  "extends": "preset:ner",
  "labels": [{ "name": "entities", "control": "SpanLabels", "classes": [{ "id": "DRUG" }, { "id": "DOSE" }] }]
}
```

Select text with the Span tool (E) to label it with the active class (1–9); click a span to
select it, Delete removes it. Export: `studio.text-spans.exporters.jsonl`.
