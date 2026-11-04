

def test_request_paths_are_redacted_before_export():
    """todo27 D3: no ids, file names or queries from request paths leave in a span."""
    from studio_observability.otel import redact_path, redact_span_fields, redact_url

    assert redact_path("/api/v1/boundary/jobs/CANARY-TOOL-ARG-7f3a") == "/api/v1/boundary/jobs/{id}"
    assert redact_path("/api/v1/projects/prj-04c0490b/files/chest%2Fimg-01.jpeg?x=1") == "/api/v1/projects/{id}/files/{id}"
    assert redact_path("/api/v1/projects/{project_id}/overview") == "/api/v1/projects/{project_id}/overview"
    assert redact_path("/healthz") == "/healthz"
    assert redact_url("http://127.0.0.1:8271/api/v1/assets/scan.dcm?sig=abc") == "http://127.0.0.1:8271/api/v1/assets/{id}"
    name, attrs = redact_span_fields("GET /api/v1/jobs/SECRET-1", {"url.path": "/api/v1/jobs/SECRET-1", "url.query": "name=scan.png", "http.route": "/api/v1/jobs/{job_id}", "http.status_code": 404})
    assert name == "GET /api/v1/jobs/{id}"
    assert attrs == {"url.path": "/api/v1/jobs/{id}", "http.route": "/api/v1/jobs/{job_id}", "http.status_code": 404}
    assert "SECRET" not in repr((name, attrs)) and "scan.png" not in repr(attrs)
