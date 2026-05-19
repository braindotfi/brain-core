# Typed Clients

Per §2 of Engineering Standards: "Every service owns its database schema.
Cross-service reads go through the owning service's API, never direct database
access."

This directory will hold generated typed clients (one per service) that other
services import to make inter-service calls. Generation lands in stage-1 or
stage-2, when we have enough types to justify it.

Do not hand-author files here. They are generated from the OpenAPI spec.
