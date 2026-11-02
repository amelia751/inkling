"""Kernel and control-plane tables (docs/plugins.md §11).

Assets and canonical annotations are kernel-owned: plugins never get their own tables for
them. Every row that belongs to a tenant carries `workspace_id`, and services filter on the
workspace from the request context, never from a request body.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import DDL, JSON, false, true, BigInteger, Boolean, DateTime, FetchedValue, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, event, func
from sqlalchemy.orm import Mapped, Session, mapped_column, with_loader_criteria

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
    # todo12 §4 M0 item 3: which worker pool may claim it (`cpu`, `memory`, `gpu`).
    resource_class: Mapped[str] = mapped_column(String(16), default="cpu", server_default="cpu")
    # Why a failed or cancelled job ended (docs/pipeline.md §12 classes, plus `cancelled`).
    error_class: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class WorkspaceResourceLimit(Base):
    """The kernel fairness gate (todo12 E4): at most `max_running` jobs of a resource class run
    at once for a workspace. Workspace `*` is the default for workspaces without their own
    row; no row at all means no cap."""

    __tablename__ = "workspace_resource_limits"
    workspace_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    resource_class: Mapped[str] = mapped_column(String(16), primary_key=True)
    max_running: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class ResourceLease(Base):
    """A scarce-resource slot (`gpu`, `memory`) held by one attempt of a job: taken in the
    claim transaction, renewed by the heartbeat, deleted on any terminal state, ignored once
    expired or once the job moved to another attempt (and then swept)."""

    __tablename__ = "resource_leases"
    __table_args__ = (Index("ix_resource_leases_slot", "workspace_id", "resource_class", "expires_at"),)
    job_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128))
    resource_class: Mapped[str] = mapped_column(String(16))
    worker_id: Mapped[str] = mapped_column(String(128))
    attempt: Mapped[int] = mapped_column(Integer)
    acquired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


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
    # The service event feed's order (todo12 §4 M0 item 6). Postgres fills it with the
    # writing transaction's id (`pg_current_xact_id()`), and the feed only reads rows below
    # the oldest running transaction, so a slow commit can never be skipped. SQLite (dev,
    # one writer) leaves it NULL and the feed orders by rowid.
    feed_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True, server_default=FetchedValue())


Index("ix_plugin_events_feed", PluginEvent.feed_seq, PluginEvent.event_id)
FEED_SEQ_DEFAULT = "(pg_current_xact_id()::text::bigint)"
event.listen(PluginEvent.__table__, "after_create", DDL(f"ALTER TABLE plugin_events ALTER COLUMN feed_seq SET DEFAULT {FEED_SEQ_DEFAULT}").execute_if(dialect="postgresql"))


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
    on_behalf_of: Mapped[str] = mapped_column(String(256), index=True)
    # The task the person had open when they minted it (todo11 D2.1): an agent may write that
    # task's environment, besides the drafts it booted. Never taken from a later request header.
    task_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # todo9: the minter's organization and permissions at mint time. An agent's `ctx.can()` is
    # these AND the token's scopes; revocation deletes the token (auth.session.revoke_sessions_for).
    org_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    permissions: Mapped[list | None] = mapped_column(JSON, nullable=True)


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
    """The account level ("Workspace" in UI copy, todo6 D1). todo9 D4: 1:1 with a WorkOS
    organization (`workos_org_id`; the WorkOS org's `external_id` is our id)."""

    __tablename__ = "organizations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    kind: Mapped[str] = mapped_column(String(16))  # personal | team
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    workos_org_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    workos_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Organization › Settings (todo9 Phase 6): our own flags, not WorkOS's.
    zero_retention: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    ai_assist: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())


class OrganizationMember(Base):
    """A mirror of WorkOS organization memberships (todo9 D5: WorkOS is the authority for org
    roles). Roles are `admin | member | billing`; rows from before todo9 may still say
    `owner | editor | viewer` (dev seeds), read as admin, member and member-read-only."""

    __tablename__ = "organization_members"
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), primary_key=True)
    principal: Mapped[str] = mapped_column(String(256), primary_key=True)
    role: Mapped[str] = mapped_column(String(16))  # admin | member | billing (legacy: owner | editor | viewer)
    workos_membership_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="active", server_default="active")  # pending | active | inactive
    role_slugs: Mapped[list | None] = mapped_column(JSON, nullable=True)
    workos_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=now, nullable=True)


# ---- Accounts (todo9 Phase 2) ------------------------------------------------------------------


class User(Base):
    """A person, mirrored from WorkOS (callback upsert + event sync). `id` is the principal
    `user:<workos user id>`; dev principals (`user:local-expert`) have no row."""

    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(256), primary_key=True)
    workos_user_id: Mapped[str] = mapped_column(String(64), unique=True)
    email: Mapped[str] = mapped_column(String(320), index=True)  # lower-cased
    first_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    marketing: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    last_sign_in_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    workos_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class UserPref(Base):
    """One preference of one person (todo14 D8), e.g. `firstRunHintsDismissed`. Keyed by the
    principal (`user:…`), not by org: a person's hints follow them across organizations."""

    __tablename__ = "user_prefs"
    principal: Mapped[str] = mapped_column(String(256), primary_key=True)
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ProjectMember(Base):
    """Project roles (todo9 D5): `owner` (shown as "Project admin") | reviewer | annotator |
    viewer. Org admins are implicitly owners everywhere and need no row."""

    __tablename__ = "project_members"
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    principal: Mapped[str] = mapped_column(String(256), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(16))
    added_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PendingProjectGrant(Base):
    """A project role promised in an invitation; becomes a `project_members` row when the
    invitation is accepted (todo9 Phase 6)."""

    __tablename__ = "pending_project_grants"
    invitation_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(16))
    added_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class OrgInvitation(Base):
    """Invitations, mirrored (workos mode: `workos_invitation_id`) or local (dev: `inv_<ulid>`)."""

    __tablename__ = "org_invitations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), index=True)
    email: Mapped[str] = mapped_column(String(320))
    role: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(16), default="pending")  # pending | accepted | expired | revoked
    inviter: Mapped[str | None] = mapped_column(String(256), nullable=True)
    workos_invitation_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    workos_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class OrgApiKey(Base):
    """Organization API keys kept locally (dev mode; workos mode uses WorkOS API keys). Only a
    hash of the secret is stored."""

    __tablename__ = "org_api_keys"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), index=True)
    name: Mapped[str] = mapped_column(String(256))
    prefix: Mapped[str] = mapped_column(String(64))
    secret_hash: Mapped[str] = mapped_column(String(64), unique=True)
    scopes: Mapped[list] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AuditEvent(Base):
    """The organization audit log (todo9 Phases 3–10): account events (sign-in, members, keys).
    Ids and non-clinical labels only. Workspace plugin actions stay in `plugin_audit`."""

    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    org_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    actor: Mapped[str] = mapped_column(String(256))
    on_behalf_of: Mapped[str | None] = mapped_column(String(256), nullable=True)
    action: Mapped[str] = mapped_column(String(128))
    target: Mapped[str | None] = mapped_column(String(256), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    __table_args__ = (Index("ix_audit_events_org_at", "org_id", "at"),)


class WorkosEventCursor(Base):
    """The Events API consumer's position (todo9 D6, Phase 7)."""

    __tablename__ = "workos_event_cursor"
    consumer: Mapped[str] = mapped_column(String(64), primary_key=True)
    last_event_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class WorkosEventProcessed(Base):
    """Events already applied: replaying them changes nothing."""

    __tablename__ = "workos_events_processed"
    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    processed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ProjectRow(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), index=True)
    title: Mapped[str] = mapped_column(String(256))
    description: Mapped[str] = mapped_column(Text, default="")
    visibility: Mapped[str] = mapped_column(String(16), default="private")  # private | shared
    # Seed projects: the manifest entry they came from (license, restricted badge).
    seed: Mapped[bool] = mapped_column(Boolean, default=False)
    # todo14 D2: the Samples template this project is a copy of (its assets share the blob keys).
    sample_of: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    # todo16 D2: in Trash (hidden from every read) until restored or purged; one batch per deletion.
    trashed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trashed_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    trash_batch_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)


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
    # Name screening (todo13 D3, D13; kernel/name_screen.py): the name an agent sees. None until
    # the current name was screened (agents then see `file-<n>.<ext>`); a flagged name becomes
    # `<kind>-<nnnn>.<ext>`, a clean one is the name itself. Reset by every rename.
    agent_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    name_flagged: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


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
    __table_args__ = (Index("ix_fs_batches_actor", "project_id", "actor", "at"), Index("ix_fs_batches_turn", "project_id", "turn_id"))
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
    # todo16: what the batch moved (`source` = the drive; dataset | collection | studio | project).
    resource: Mapped[str] = mapped_column(String(16), default="source", server_default="source")
    # todo16 D9: the person an assistant acted for (None: the person's own change) and the
    # assistant turn (`X-Turn-Id`), so a whole turn can be listed and undone (kernel/turns.py).
    on_behalf_of: Mapped[str | None] = mapped_column(String(256), nullable=True)
    turn_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
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
    # todo13: the drop (one gesture) this session belongs to, if any.
    drop_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)


class Drop(Base):
    """One drop gesture (todo13 §5 "Drop"): files dropped, pasted or attached in a chat, on Home,
    in Files or on a Studio canvas. Its import sessions carry `drop_id`; chat drops land in
    `Shared in chat/<conversation>` (`folder_node_id`). `removed` lists the node ids taken out of
    the chat (the reference only: the Files stay, D4)."""

    __tablename__ = "drops"
    __table_args__ = (Index("ix_drops_conversation", "project_id", "conversation_id"), Index("ix_drops_rate", "created_by", "created_at"))
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    origin: Mapped[str] = mapped_column(String(16))  # chat | files | studio | home
    conversation_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    message_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    task_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    dataset_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    folder_node_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # uploading | inspecting | classified | planned | applied | failed
    state: Mapped[str] = mapped_column(String(16), default="uploading")
    # What the browser announced (files, bytes) before hashing, for the card and the limits.
    declared: Mapped[dict] = mapped_column(JSON, default=dict)
    removed: Mapped[list] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


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
    # todo16 D2: in Trash (hidden from every read) until restored or purged; one batch per deletion.
    trashed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trashed_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    trash_batch_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)


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
    # todo13 D7: the collection this task works on. None = every collection of its dataset (tasks
    # made before collections whose dataset holds several viewable kinds keep seeing them all).
    collection_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # todo16 D2: in Trash (hidden from every read) until restored or purged; one batch per deletion.
    trashed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trashed_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    trash_batch_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)


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


class TaskItem(Base):
    """An item of a task as it ingests (todo11 D8): one row per file dropped into a Studio,
    from `registered` (the file list arrived) through `uploaded`, `probed`, `thumb_ready`,
    `preview_ready` to `ready` (or `failed`). `id` is the cursor order; `item_id` is the item's
    stable id (the content-addressed storage path the bytes land at). `priority` is the latest
    "these are on screen" hint (ms since the epoch), so workers serve visible items first."""

    __tablename__ = "task_items"
    __table_args__ = (UniqueConstraint("task_id", "item_id"), Index("ix_task_items_claim", "state", "priority"))
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_id: Mapped[str] = mapped_column(String(128), index=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    session_id: Mapped[str] = mapped_column(String(64))
    client_file_id: Mapped[str] = mapped_column(String(128))
    item_id: Mapped[str] = mapped_column(String(2048))
    node_id: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(1024))
    rel_path: Mapped[str] = mapped_column(String(2048))
    kind: Mapped[str] = mapped_column(String(32))
    size: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), default=0)
    sha256: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(16))
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    priority: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), default=0)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


# ---- todo13 Milestone 2: collections, drop plans, dataset structure -------------------------------


class DatasetCollectionRow(Base):
    """A dataset's collection (todo13 D7): one logical kind ("Chest X-rays", "CT series", "Labels
    table"). Which files belong to it: the dataset's pinned file refs with this `collectionId`,
    else (refs made before collections) the refs whose pinned kind is the collection's kind.
    `suggested` until a person confirms the dataset's structure (D8)."""

    __tablename__ = "dataset_collections"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    name: Mapped[str] = mapped_column(String(256))
    kind: Mapped[str] = mapped_column(String(32))
    # Technical shape the classifier matches on (`{"modality": "CT"}`); never content values.
    shape: Mapped[dict] = mapped_column(JSON, default=dict)
    suggested: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    # todo16 D2: in Trash (hidden from every read) until restored or purged; one batch per deletion.
    trashed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trashed_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    trash_batch_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)


class DropPlanRow(Base):
    """A drop's classification and plan (todo13 D5, D6), and what applying it created, so Undo
    can take exactly that back. Keyed by the drop id (the `drops` table is todo13-drops')."""

    __tablename__ = "drop_plans"
    drop_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    # planned | applying | applied | undone | failed
    state: Mapped[str] = mapped_column(String(16), default="planned")
    plan: Mapped[dict] = mapped_column(JSON, default=dict)
    groups: Mapped[list] = mapped_column(JSON, default=list)
    # What the plan was made against: {datasetId?, taskId?, origin?, request?}.
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    auto: Mapped[bool] = mapped_column(Boolean, default=False)
    fast_path: Mapped[bool] = mapped_column(Boolean, default=False)
    # {datasetsCreated, collectionsCreated, tasksCreated, refsAdded: {datasetId: [nodeId]}, pipelineRunIds, unpackRequested}
    applied: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_by: Mapped[str] = mapped_column(String(256))
    applied_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    undo_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class DatasetStructureRow(Base):
    """`structure.json` (todo13 D8) per dataset and branch: `draft` is the person's working draft;
    an agent's proposal lives on its `work/agent-*` branch until accepted. Kept by the kernel
    until apps/versioning admits `structure.json` in a commit's tree (then mirrored there)."""

    __tablename__ = "dataset_structures"
    dataset_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    branch: Mapped[str] = mapped_column(String(256), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    structure: Mapped[dict] = mapped_column(JSON, default=dict)
    hash: Mapped[str] = mapped_column(String(80))
    updated_by: Mapped[str] = mapped_column(String(256))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


# ---- todo16 D2: trashed rows are hidden from every ORM read -----------------------------------

TRASHABLE = (ProjectRow, DatasetRow, DatasetCollectionRow, TaskRow)
INCLUDE_TRASHED = {"include_trashed": True}


def _not_trashed(cls):  # noqa: ANN001, ANN202
    return cls.trashed_at.is_(None)


@event.listens_for(Session, "do_orm_execute")
def _hide_trashed(state) -> None:  # noqa: ANN001
    """Every ORM select (lists, `db.get`, counts) leaves trashed datasets, collections, Studios and
    projects out, unless it asks `execution_options(include_trashed=True)` (the Trash itself)."""
    if not state.is_select or state.is_column_load or state.is_relationship_load or state.execution_options.get("include_trashed"):
        return
    state.statement = state.statement.options(*(with_loader_criteria(m, _not_trashed, include_aliases=True) for m in TRASHABLE))


class ApprovalUsed(Base):
    """todo16 D8: an assistant's destroy approval (a signed token from the agent) is good once.
    Its id lands here when the api honours it; a second use is refused."""

    __tablename__ = "approvals_used"
    approval_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    person: Mapped[str | None] = mapped_column(String(256), nullable=True)
    operation: Mapped[str | None] = mapped_column(String(64), nullable=True)
    project_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


# ---- Rules, lint findings, idempotency (todo17 D3, D10, D13; migration 0019) ---------------


class ProjectRules(Base):
    """A project's `rules.v1` document (todo17 D3). Absent = the preset's defaults, revision 0."""

    __tablename__ = "project_rules"
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    rules: Mapped[dict] = mapped_column(JSON)
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    updated_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ProjectRulesHistory(Base):
    """Every saved rules revision, append-only (`GET /api/v1/projects/:id/rules/history`)."""

    __tablename__ = "project_rules_history"
    __table_args__ = (UniqueConstraint("project_id", "revision", name="uq_project_rules_history_revision"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    rules: Mapped[dict] = mapped_column(JSON)
    actor: Mapped[str] = mapped_column(String(256))
    on_behalf_of: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class LintFinding(Base):
    """What a write or a scan found against the project's rules (todo17 D10)."""

    __tablename__ = "lint_findings"
    __table_args__ = (
        Index("ix_lint_findings_project_open", "project_id", "resolved_at"),
        Index("ix_lint_findings_resource", "resource_kind", "resource_id"),
    )
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: uuid.uuid4().hex)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"))
    resource_kind: Mapped[str] = mapped_column(String(32))
    resource_id: Mapped[str] = mapped_column(String(128))
    rule: Mapped[str] = mapped_column(String(128))
    severity: Mapped[str] = mapped_column(String(16))
    path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    message: Mapped[str] = mapped_column(Text, default="", server_default="")
    source: Mapped[str] = mapped_column(String(8))  # write | scan
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class IdempotencyKey(Base):
    """A mutating request's `Idempotency-Key` (todo17 D13): same key + same body replays
    `response` (`{status, body}`); a different body is 422; `status` 'in_progress' means the first one
    is still running (409), 'done' once stored."""

    __tablename__ = "idempotency_keys"
    key: Mapped[str] = mapped_column(String(256), primary_key=True)
    principal: Mapped[str] = mapped_column(String(256), primary_key=True)
    op_id: Mapped[str] = mapped_column(String(256))
    body_hash: Mapped[str] = mapped_column(String(71))
    status: Mapped[str] = mapped_column(String(16))
    response: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


# ---- todo17 cr: change requests (D7; migration 0022) ------------------------------------------


class ChangeRequest(Base):
    """An actor's operations on published things, checked, then merged (auto or by a person)."""

    __tablename__ = "change_requests"
    __table_args__ = (Index("ix_change_requests_project_state", "project_id", "state"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: uuid.uuid4().hex)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"))
    title: Mapped[str] = mapped_column(String(300), default="", server_default="")
    actor: Mapped[str] = mapped_column(String(256))
    on_behalf_of: Mapped[str | None] = mapped_column(String(256), nullable=True)
    agent: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # open | checking | passed | failed | needs-update | merged | closed
    state: Mapped[str] = mapped_column(String(16))
    base: Mapped[dict] = mapped_column(JSON, default=dict)  # resource -> revision when first touched
    operations: Mapped[list] = mapped_column(JSON, default=list)  # [{op, input, base_revision?}]
    findings: Mapped[list] = mapped_column(JSON, default=list)  # Violation json
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    merged_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    merged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ChangeRequestComment(Base):
    __tablename__ = "change_request_comments"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: uuid.uuid4().hex)
    change_request_id: Mapped[str] = mapped_column(ForeignKey("change_requests.id"), index=True)
    author: Mapped[str] = mapped_column(String(256))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


# todo17 agents-api (D12): outside agents connected over MCP OAuth, and the approvals a person
# gives for their destroy operations.


class AgentConnection(Base):
    """An outside agent (an MCP OAuth client) a person signed in: one row per person and client
    until revoked. Tokens are WorkOS AuthKit's; revoking here makes every token issued before
    `revoked_at` answer 401 (`auth/oauth.py`). A later sign-in makes a new row."""

    __tablename__ = "agent_connections"
    __table_args__ = (Index("ix_agent_connections_person", "person_id", "client_id"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    org_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    person_id: Mapped[str] = mapped_column(String(256))
    client_name: Mapped[str] = mapped_column(String(256))
    client_id: Mapped[str] = mapped_column(String(256))
    scopes: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AgentApproval(Base):
    """A destroy an outside agent asked for (202): a person approves or denies it from the link;
    the agent then retries with `X-Approval-Id: <id>` (single use, `approvals_used`)."""

    __tablename__ = "agent_approvals"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    connection_id: Mapped[str] = mapped_column(String(64), index=True)
    person_id: Mapped[str] = mapped_column(String(256), index=True)
    project_id: Mapped[str] = mapped_column(String(128))
    operation: Mapped[str] = mapped_column(String(64))
    targets: Mapped[list] = mapped_column(JSON, default=list)
    state: Mapped[str] = mapped_column(String(16), default="pending")  # pending | approved | denied
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
