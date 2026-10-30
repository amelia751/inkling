"""Kernel and control-plane tables (docs/plugins.md §11).

Assets and canonical annotations are kernel-owned: plugins never get their own tables for
them. Every row that belongs to a tenant carries `workspace_id`, and services filter on the
workspace from the request context, never from a request body.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
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
    """One canonical annotation document per workspace (the shape the Studio loads and saves)."""

    __tablename__ = "annotation_documents"
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), primary_key=True)
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
    __tablename__ = "workspace_environments"
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    environment: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    author: Mapped[str | None] = mapped_column(String(256), nullable=True)
    saved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WorkspaceEnvironmentRevision(Base):
    """Every saved environment, append-only (`GET /api/environments/:id/history`)."""

    __tablename__ = "workspace_environment_history"
    __table_args__ = (UniqueConstraint("workspace_id", "revision"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    environment: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    author: Mapped[str | None] = mapped_column(String(256), nullable=True)
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


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
