"""Kernel and control-plane tables (docs/plugins.md §11).

Assets and canonical annotations are kernel-owned: plugins never get their own tables for
them. Every row that belongs to a tenant carries `workspace_id`, and services filter on the
workspace from the request context, never from a request body.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def now() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return uuid.uuid4().hex


# ---- Kernel ------------------------------------------------------------------------------


class Workspace(Base):
    __tablename__ = "workspaces"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class SessionToken(Base):
    """Session-scoped tokens (agent runs, workers). Principal and workspace come from here, never from arguments."""

    __tablename__ = "session_tokens"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    principal: Mapped[str] = mapped_column(String(256))
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"))
    scopes: Mapped[list] = mapped_column(JSON, default=list)
    profile: Mapped[str | None] = mapped_column(String(32), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Asset(Base):
    __tablename__ = "assets"
    __table_args__ = (UniqueConstraint("workspace_id", "path"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    path: Mapped[str] = mapped_column(String(1024))
    media_type: Mapped[str] = mapped_column(String(128))
    role: Mapped[str | None] = mapped_column(String(64), nullable=True)
    size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Artifact(Base):
    """Derived artifacts (mask PNGs, exports) written through the Asset API."""

    __tablename__ = "artifacts"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    media_type: Mapped[str] = mapped_column(String(128))
    path: Mapped[str] = mapped_column(String(1024))
    source_asset_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AnnotationDocumentRow(Base):
    """One canonical annotation document per task (the shape the Studio loads and saves).
    Seeds and older workspaces use `task_id == workspace_id` (migration 0004)."""

    __tablename__ = "annotation_documents"
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    annotations_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    annotations: Mapped[list] = mapped_column(JSON, default=list)
    saved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AnnotationCommit(Base):
    """Committed plugin outputs by idempotency key, so a re-run never duplicates annotations (§14 #7)."""

    __tablename__ = "annotation_commits"
    __table_args__ = (UniqueConstraint("workspace_id", "idempotency_key"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(256))
    job_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    annotation_ids: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Secret(Base):
    """Encrypted at rest; plaintext only ever leaves through the broker's proxied call."""

    __tablename__ = "secrets"
    __table_args__ = (UniqueConstraint("workspace_id", "name"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    ciphertext: Mapped[str] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class WorkspaceEnvironment(Base):
    """The saved environment of one task (`task_id == workspace_id` for seeds)."""

    __tablename__ = "workspace_environments"
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    environment: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    author: Mapped[str | None] = mapped_column(String(256), nullable=True)
    saved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WorkspaceEnvironmentRevision(Base):
    """Every saved environment, append-only (`GET /api/environments/:id/history`)."""

    __tablename__ = "workspace_environment_history"
    __table_args__ = (UniqueConstraint("workspace_id", "task_id", "revision"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    task_id: Mapped[str] = mapped_column(String(128))
    revision: Mapped[int] = mapped_column(Integer)
    environment: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    author: Mapped[str | None] = mapped_column(String(256), nullable=True)
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    # todo10 Phase 1: RFC 8785 hash of `environment`, of the revision it replaced (a first
    # revision: its base), who made it (`person` | `agent`) and, for agents, run and prompt hash.
    content_hash: Mapped[str] = mapped_column(String(71))
    parent_hash: Mapped[str] = mapped_column(String(71))
    author_kind: Mapped[str] = mapped_column(String(16), default="person")
    agent_run_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    prompt_hash: Mapped[str | None] = mapped_column(String(71), nullable=True)


# ---- Plugins (§11) -----------------------------------------------------------------------


class PluginPackage(Base):
    __tablename__ = "plugin_packages"
    id: Mapped[str] = mapped_column(String(256), primary_key=True)
    publisher: Mapped[str] = mapped_column(String(256))
    license: Mapped[str] = mapped_column(String(128))
    trust_tier: Mapped[str] = mapped_column(String(32))  # first-party | vetted | generated


class PluginVersion(Base):
    __tablename__ = "plugin_versions"
    plugin_id: Mapped[str] = mapped_column(ForeignKey("plugin_packages.id"), primary_key=True)
    version: Mapped[str] = mapped_column(String(64), primary_key=True)
    artifact_digest: Mapped[str] = mapped_column(String(128))
    manifest: Mapped[dict] = mapped_column(JSON)
    signature: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PluginArtifact(Base):
    """Signed, content-addressed plugin artifacts the kernel built or imported (todo10 Phase 3, 8).

    The bytes live in the BlobStore at `artifacts/sha256/<hex>` (an OCI manifest, its config and
    one package layer, plus signature and attestation referrers); this row is the registry
    entry. `manifest_digest` is what's signed; `artifact_digest` is the package tree digest that
    workspace pins and lockfiles carry. Rows are immutable except for promotion (tier, org).
    """

    __tablename__ = "plugin_artifacts"
    plugin_id: Mapped[str] = mapped_column(String(256), primary_key=True)
    version: Mapped[str] = mapped_column(String(64), primary_key=True)
    manifest_digest: Mapped[str] = mapped_column(String(80), index=True)
    artifact_digest: Mapped[str] = mapped_column(String(80))
    trust_tier: Mapped[str] = mapped_column(String(32), default="generated")  # generated | organisation | curated
    publisher: Mapped[str] = mapped_column(String(256))
    # generated: visible to this workspace only; organisation: to every project of org_id.
    workspace_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    org_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    manifest: Mapped[dict] = mapped_column(JSON)
    signature: Mapped[dict] = mapped_column(JSON)
    referrers: Mapped[list] = mapped_column(JSON, default=list)
    attestation_digest: Mapped[str | None] = mapped_column(String(80), nullable=True)
    review: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    licenses: Mapped[dict] = mapped_column(JSON, default=dict)
    source: Mapped[str] = mapped_column(String(32), default="built")  # built | imported
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    promoted_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    promoted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PluginPromotion(Base):
    """Append-only promotion reviews (todo10 Phase 8): generated → organisation → curated."""

    __tablename__ = "plugin_promotions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plugin_id: Mapped[str] = mapped_column(String(256), index=True)
    version: Mapped[str] = mapped_column(String(64))
    manifest_digest: Mapped[str] = mapped_column(String(80))
    from_tier: Mapped[str] = mapped_column(String(32))
    to_tier: Mapped[str] = mapped_column(String(32))
    state: Mapped[str] = mapped_column(String(16))  # requested | approved | rejected
    requested_by: Mapped[str] = mapped_column(String(256))
    reviewed_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    workspace_id: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PluginCapability(Base):
    __tablename__ = "plugin_capabilities"
    plugin_id: Mapped[str] = mapped_column(String(256), primary_key=True)
    version: Mapped[str] = mapped_column(String(64), primary_key=True)
    capability_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    schema_ref: Mapped[str | None] = mapped_column(String(512), nullable=True)


class WorkspacePlugin(Base):
    """The active (or last) installation of a plugin in a workspace: the atomic pin of §7.2."""

    __tablename__ = "workspace_plugins"
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), primary_key=True)
    plugin_id: Mapped[str] = mapped_column(String(256), primary_key=True)
    version: Mapped[str] = mapped_column(String(64))
    artifact_digest: Mapped[str | None] = mapped_column(String(128), nullable=True)
    config_revision: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class WorkspacePluginHistory(Base):
    """Append-only installation history; rollback restores the previous ACTIVATED row (§7.3)."""

    __tablename__ = "workspace_plugin_history"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[str] = mapped_column(String(128), index=True)
    plugin_id: Mapped[str] = mapped_column(String(256))
    version: Mapped[str] = mapped_column(String(64))
    artifact_digest: Mapped[str | None] = mapped_column(String(128), nullable=True)
    config_revision: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[str] = mapped_column(String(32))
    actor: Mapped[str] = mapped_column(String(256))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class InstallRequest(Base):
    """One run of the §7.2 state machine: REQUESTED → … → ACTIVATED | REJECTED."""

    __tablename__ = "plugin_install_requests"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    plugin_id: Mapped[str] = mapped_column(String(256))
    version: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(32))
    plan: Mapped[dict] = mapped_column(JSON, default=dict)
    checks: Mapped[dict] = mapped_column(JSON, default=dict)
    requested_by: Mapped[str] = mapped_column(String(256))
    approved_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class WorkspacePluginGrant(Base):
    """A granted permission, bound to plugin version + workspace + granting actor (§10.1)."""

    __tablename__ = "workspace_plugin_grants"
    workspace_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    plugin_id: Mapped[str] = mapped_column(String(256), primary_key=True)
    version: Mapped[str] = mapped_column(String(64), primary_key=True)
    permission: Mapped[str] = mapped_column(String(256), primary_key=True)
    granted_by: Mapped[str] = mapped_column(String(256))
    granted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PermissionUse(Base):
    """Permission *used* (as opposed to requested or granted), recorded by the gateway and broker."""

    __tablename__ = "plugin_permission_uses"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[str] = mapped_column(String(128), index=True)
    plugin_id: Mapped[str] = mapped_column(String(256))
    version: Mapped[str] = mapped_column(String(64))
    permission: Mapped[str] = mapped_column(String(256))
    job_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class WorkspacePluginConfig(Base):
    __tablename__ = "workspace_plugin_configs"
    workspace_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    plugin_id: Mapped[str] = mapped_column(String(256), primary_key=True)
    config_revision: Mapped[int] = mapped_column(Integer, primary_key=True)
    config_json: Mapped[dict] = mapped_column(JSON, default=dict)
    secret_refs: Mapped[list] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PluginJob(Base):
    __tablename__ = "plugin_jobs"
    __table_args__ = (UniqueConstraint("workspace_id", "idempotency_key"),)
    job_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    plugin_id: Mapped[str] = mapped_column(String(256))
    version: Mapped[str] = mapped_column(String(64))
    capability: Mapped[str | None] = mapped_column(String(128), nullable=True)
    tool: Mapped[str] = mapped_column(String(128))
    provider: Mapped[str | None] = mapped_column(String(128), nullable=True)
    input: Mapped[dict] = mapped_column(JSON)
    state: Mapped[str] = mapped_column(String(32), index=True)  # queued running succeeded failed cancelled
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    recoverable: Mapped[bool] = mapped_column(Boolean, default=True)
    estimated_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    idempotency_key: Mapped[str | None] = mapped_column(String(256), nullable=True)
    correlation_id: Mapped[str] = mapped_column(String(64))
    principal: Mapped[str] = mapped_column(String(256))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    timeout_s: Mapped[int] = mapped_column(Integer, default=180)
    worker_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # W3C trace context of the request that enqueued the job; the worker continues that trace.
    traceparent: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # The task whose document the job's annotations land in (todo6 D3); None = the workspace's own.
    task_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class PluginEvent(Base):
    """Typed outbox (§6 Event API): at-least-once delivery, idempotency key, depth for recursion guards."""

    __tablename__ = "plugin_events"
    __table_args__ = (UniqueConstraint("workspace_id", "idempotency_key"),)
    event_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    type: Mapped[str] = mapped_column(String(128))
    idempotency_key: Mapped[str | None] = mapped_column(String(256), nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    payload_ref: Mapped[str | None] = mapped_column(String(512), nullable=True)
    source: Mapped[str] = mapped_column(String(256))
    correlation_id: Mapped[str] = mapped_column(String(64))
    depth: Mapped[int] = mapped_column(Integer, default=0)
    delivered: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PluginAudit(Base):
    """Append-only (§6 Audit API). Services only ever insert."""

    __tablename__ = "plugin_audit"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_id: Mapped[str] = mapped_column(String(256))
    workspace_id: Mapped[str] = mapped_column(String(128), index=True)
    action: Mapped[str] = mapped_column(String(128))
    target: Mapped[str | None] = mapped_column(String(512), nullable=True)
    before_ref: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after_ref: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    correlation_id: Mapped[str] = mapped_column(String(64))
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    # The person an agent acted for (SessionDelegation), so Activity can say "the assistant, for Ana".
    on_behalf_of: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # todo10 §3.4: per-workspace hash chain (kernel/audit.py); NULL on entries from before it.
    prev_hash: Mapped[str | None] = mapped_column(String(71), nullable=True)
    entry_hash: Mapped[str | None] = mapped_column(String(71), nullable=True)


# ---- Studio definitions (todo10 §3.2, §3.4) ----------------------------------------------


class TaskStudioNotes(Base):
    """`.studio/tasks/<id>/README.md`: a task's intent and notes, by a person or the agent."""

    __tablename__ = "task_studio_notes"
    workspace_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    readme: Mapped[str] = mapped_column(Text)
    updated_by: Mapped[str] = mapped_column(String(256))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class StudioKnownGood(Base):
    """The `last-known-good` ref of a task: moved only by a person or by passing checks.
    Safe mode boots from it; rollback restores it (environment and plugin pins)."""

    __tablename__ = "studio_known_good"
    workspace_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(71))
    environment: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    lockfile: Mapped[dict] = mapped_column(JSON)
    lockfile_hash: Mapped[str] = mapped_column(String(71))
    commit_oid: Mapped[str | None] = mapped_column(String(40), nullable=True)
    moved_by: Mapped[str] = mapped_column(String(256))
    moved_because: Mapped[str] = mapped_column(String(32))  # person | checks
    moved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


# ---- Dataset versioning (todo4 Phase 6) ---------------------------------------------------
# apps/versioning owns branches, commits, reviews and releases. The kernel keeps only what it
# needs to route and attribute calls, plus the Studio's lossless annotation payloads.


class DatasetRepo(Base):
    """A workspace dataset → its versioning repository (an opaque uuid)."""

    __tablename__ = "dataset_repos"
    workspace_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    repo_id: Mapped[str] = mapped_column(String(64))
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class SessionDelegation(Base):
    """Who a session token acts for (its minter): the `on_behalf_of` of agent actors."""

    __tablename__ = "session_delegations"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    on_behalf_of: Mapped[str] = mapped_column(String(256))
    # The task the person had open when they minted it (todo11 D2.1): an agent may write that
    # task's environment, besides the drafts it booted. Never taken from a later request header.
    task_id: Mapped[str | None] = mapped_column(String(128), nullable=True)


class VersionedAnnotationPayload(Base):
    """The Studio annotation behind an annotation-revision ref, so a branch loads back into
    the Studio losslessly (revisions carry only what the semantic diff needs)."""

    __tablename__ = "versioned_annotation_payloads"
    workspace_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    ref: Mapped[str] = mapped_column(String(80), primary_key=True)
    annotation_id: Mapped[str] = mapped_column(String(256), index=True)
    # sha256(studio hash + ontology revision): saving an unchanged annotation reuses its ref.
    cache_key: Mapped[str] = mapped_column(String(64), index=True)
    annotation: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class EventConsumption(Base):
    """Built-in subscribers (the worker's de-identification check) acknowledge outbox events
    here, apart from plugin fan-out, so each subscriber handles each event once."""

    __tablename__ = "event_consumptions"
    subscriber: Mapped[str] = mapped_column(String(128), primary_key=True)
    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


# ---- Projects, sources, datasets and tasks (todo6 Phase 1, docs/ux.md §2) ---------------------
# Organization ⊃ Project ⊃ Dataset ⊃ Task, plus Files (todo7: bytes immutable, names yours). A project's
# kernel `workspaces` row has the same id (todo6 D1), so plugin activation is per project.


class Organization(Base):
    """The account level ("Workspace" in UI copy, todo6 D1)."""

    __tablename__ = "organizations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    kind: Mapped[str] = mapped_column(String(16))  # personal | team
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class OrganizationMember(Base):
    __tablename__ = "organization_members"
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), primary_key=True)
    principal: Mapped[str] = mapped_column(String(256), primary_key=True)
    role: Mapped[str] = mapped_column(String(16))  # owner | editor | viewer


class ProjectRow(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), index=True)
    title: Mapped[str] = mapped_column(String(256))
    description: Mapped[str] = mapped_column(Text, default="")
    visibility: Mapped[str] = mapped_column(String(16), default="private")  # private | shared
    # Seed projects: the manifest entry they came from (license, restricted badge).
    seed: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class Source(Base):
    """Import provenance (todo7 D1): one per upload (or seed). Its folder is a top-level
    folder of the project's drive; who brought what, when, from where."""

    __tablename__ = "sources"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    title: Mapped[str] = mapped_column(String(256))
    kind: Mapped[str] = mapped_column(String(16))  # upload | seed | connector
    root_node_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by: Mapped[str] = mapped_column(String(256))
    status: Mapped[str] = mapped_column(String(32), default="ready")  # uploading | inspecting | ready | failed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class SourceNode(Base):
    """A file or folder of the project's drive (todo7). Bytes are immutable; the namespace
    (name, parent, Trash) is the user's, and every change to it is journaled in `fs_ops`.

    Ids are opaque and permanent (D3): new nodes are `nod-<uuid hex>`; seeds keep the hashed
    ids they were backfilled with. The current path is computed from the parent chain (D4);
    `original_path` is the path a file arrived with (immutable, sensitive: Phase 7)."""

    __tablename__ = "source_nodes"
    __table_args__ = (Index("ix_source_nodes_children", "source_id", "parent_id", "name"), Index("ix_source_nodes_parent", "parent_id"))
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    # Import provenance (who brought the bytes, D1); None for folders made in Files and the drive root.
    source_id: Mapped[str | None] = mapped_column(ForeignKey("sources.id"), index=True, nullable=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    # The project's drive root (D1); the root itself has parent_id None.
    project_root: Mapped[str | None] = mapped_column(String(64), nullable=True)
    parent_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    name: Mapped[str] = mapped_column(String(512))
    # Existing case-only duplicate siblings (D10) are numbered 1, 2…; new names are unique (0).
    name_dup: Mapped[int] = mapped_column(Integer, default=0)
    original_path: Mapped[str] = mapped_column(String(2048), default="")
    is_dir: Mapped[bool] = mapped_column(Boolean, default=False)
    asset_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    size: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # None until the worker inspected the file (the UI shows "Checking…").
    detected_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    facts: Mapped[dict] = mapped_column(JSON, default=dict)
    flags: Mapped[dict] = mapped_column(JSON, default=dict)  # privacy, unsupported, duplicate_of
    # A numbered run (`scan001…scan120.dcm`) shares one key, so it collapses into one row.
    sequence_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # Not in Trash only: children, files below, and the bytes of the files below (folders).
    child_count: Mapped[int] = mapped_column(Integer, default=0)
    descendant_count: Mapped[int] = mapped_column(Integer, default=0)
    total_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    # Folders: bumped whenever their children change (`fs/ops` `expect`).
    revision: Mapped[int] = mapped_column(Integer, default=0)
    # Sample data (D2): every write that would change it is refused.
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    # Files: the current version (D6); `node_versions` keeps every one.
    version: Mapped[int] = mapped_column(Integer, default=1)
    # Trash (D8): only the trashed node is marked; its descendants are hidden with it.
    trashed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trashed_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    trash_batch_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    import_session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


# Names are unique per folder, case-insensitively, among nodes not in Trash (D10).
Index(
    "uq_source_nodes_sibling_name",
    SourceNode.parent_id,
    func.lower(SourceNode.name),
    SourceNode.name_dup,
    unique=True,
    sqlite_where=SourceNode.trashed_at.is_(None),
    postgresql_where=SourceNode.trashed_at.is_(None),
)
# Trash listings and the purge job. Partial (only what's in Trash): a plain index on
# `trashed_at` would tempt SQLite into scanning it for `trashed_at IS NULL` in tree walks.
Index("ix_source_nodes_trash", SourceNode.project_id, SourceNode.trashed_at, sqlite_where=SourceNode.trashed_at.is_not(None), postgresql_where=SourceNode.trashed_at.is_not(None))


class NodeVersion(Base):
    """Every version of a file (D6): replacing adds one, the old asset stays referenced here."""

    __tablename__ = "node_versions"
    node_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    asset_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    size: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # What inspection said about these bytes, so restoring a version brings its facts back.
    detected_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    facts: Mapped[dict] = mapped_column(JSON, default=dict)
    flags: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class FsBatch(Base):
    """One `fs/ops` call (or an undo / redo of one): the unit of undo (D9)."""

    __tablename__ = "fs_batches"
    __table_args__ = (Index("ix_fs_batches_actor", "project_id", "actor", "at"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    actor: Mapped[str] = mapped_column(String(256))
    kind: Mapped[str] = mapped_column(String(16))  # ops | undo | redo
    # "move of 3 items": for the Undo hint (no file names: they may identify a person).
    label: Mapped[str] = mapped_column(String(256), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    undoable: Mapped[bool] = mapped_column(Boolean, default=True)
    reverts_batch_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    undone_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    redone_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    seq: Mapped[int] = mapped_column(Integer, default=0)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class FsOp(Base):
    """The journal (D9): one row per node an operation changed, with its state before and
    after (`None` = the node didn't exist / doesn't any more). Undo applies `before`."""

    __tablename__ = "fs_ops"
    __table_args__ = (Index("ix_fs_ops_actor", "project_id", "actor", "at"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(String(128))
    batch_id: Mapped[str] = mapped_column(String(64), index=True)
    actor: Mapped[str] = mapped_column(String(256))
    # mkdir | rename | move | copy | trash | restore | purge | replace | restore_version
    kind: Mapped[str] = mapped_column(String(32))
    node_id: Mapped[str] = mapped_column(String(64), index=True)
    before: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    undone_by_batch: Mapped[str | None] = mapped_column(String(64), nullable=True)


class NodeStar(Base):
    __tablename__ = "node_stars"
    node_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    principal: Mapped[str] = mapped_column(String(256), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class NodeRecent(Base):
    """Files and folders a person opened in the inspector (with `fs_ops`: Recent)."""

    __tablename__ = "node_recent"
    node_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    principal: Mapped[str] = mapped_column(String(256), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ScheduledRun(Base):
    """Periodic kernel work (`files.empty_trash`): one row per (job, period), inserted with
    ON CONFLICT DO NOTHING, so a period runs once whichever replica or worker asks first."""

    __tablename__ = "scheduled_runs"
    name: Mapped[str] = mapped_column(String(128), primary_key=True)
    period: Mapped[str] = mapped_column(String(32), primary_key=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ImportSession(Base):
    """uploading → inspecting → needs_review | ready → imported | failed (and cancelled)."""

    __tablename__ = "import_sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    source_id: Mapped[str] = mapped_column(String(128))
    target_node_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    state: Mapped[str] = mapped_column(String(32))
    totals: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(256))
    attested_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    attested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class UploadFile(Base):
    __tablename__ = "upload_files"
    session_id: Mapped[str] = mapped_column(ForeignKey("import_sessions.id"), primary_key=True)
    client_file_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    rel_path: Mapped[str] = mapped_column(String(2048))
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    received: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[str] = mapped_column(String(32))  # pending | uploaded | skipped_duplicate | rejected | failed
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The node this file became (D3): completing a session twice finds it instead of a path hash.
    node_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


class DatasetRow(Base):
    __tablename__ = "datasets"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    title: Mapped[str] = mapped_column(String(256))
    description: Mapped[str] = mapped_column(Text, default="")
    # Which source nodes, how items group, and which labels came from which column.
    definition: Mapped[dict] = mapped_column(JSON, default=dict)
    created_from_proposal_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class TaskRow(Base):
    """Work on a dataset. Its environment and annotation document are keyed by `task_id`."""

    __tablename__ = "tasks"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    title: Mapped[str] = mapped_column(String(256))
    kind: Mapped[str] = mapped_column(String(64))
    revision: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    # todo11 D1: a boot makes `draft` tasks; only a person publishes them. Everything made
    # before (and every task a person creates) is `published`.
    state: Mapped[str] = mapped_column(String(16), default="published", server_default="published")
    boot_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # Who made the draft: `agent:<run>` or `user:…`, and the person it was made for.
    booted_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    published_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Boot(Base):
    """A Studio boot (todo11 D1, `POST /api/v1/projects/:id/boots`): idempotent on `id` (the
    caller's bootId). Its progress is also on the project event stream as `boot.*`."""

    __tablename__ = "boots"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    preset: Mapped[str] = mapped_column(String(128))
    state: Mapped[str] = mapped_column(String(16))  # running | ready | failed
    task_ids: Mapped[list] = mapped_column(JSON, default=list)
    steps: Mapped[list] = mapped_column(JSON, default=list)
    # {kind: person|agent, runId?}; `principal` is the caller, `on_behalf_of` the person.
    initiator: Mapped[dict] = mapped_column(JSON, default=dict)
    principal: Mapped[str] = mapped_column(String(256))
    on_behalf_of: Mapped[str] = mapped_column(String(256))
    # Hash of the request body, so a replay with a different body is a 409, not a silent no-op.
    request_hash: Mapped[str] = mapped_column(String(80))
    error: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Proposal(Base):
    """Something the worker, the assistant or a person suggests. Changes nothing until a
    person confirms it (docs/ux.md §9)."""

    __tablename__ = "proposals"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    kind: Mapped[str] = mapped_column(String(32))  # group | relationship | mapping | dataset | task
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    evidence: Mapped[dict] = mapped_column(JSON, default=dict)
    strength: Mapped[str] = mapped_column(String(16))  # strong | possible | weak
    status: Mapped[str] = mapped_column(String(16), default="proposed")  # proposed | confirmed | dismissed | superseded
    import_session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by: Mapped[str] = mapped_column(String(256))  # worker:inspect | agent:<run> | user:…
    decided_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ProjectResume(Base):
    """Where a person left off in a project (todo6 D9): server-side, so it follows them."""

    __tablename__ = "project_resume"
    project_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    principal: Mapped[str] = mapped_column(String(256), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(128))
    item_id: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    placement: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    tool: Mapped[str | None] = mapped_column(String(128), nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
