from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.manifest import Manifest
from ...models.manifest_root import ManifestRoot
from ...models.problem import Problem
from typing import cast
from uuid import UUID



def _get_kwargs(
    repo_id: UUID,
    *,
    body: Manifest,

) -> dict[str, Any]:
    headers: dict[str, Any] = {}


    

    

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/internal/v1/repos/{repo_id}/manifests".format(repo_id=repo_id,),
    }

    _kwargs["json"] = body.to_dict()


    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> ManifestRoot | Problem:
    if response.status_code == 201:
        response_201 = ManifestRoot.from_dict(response.json())



        return response_201

    response_default = Problem.from_dict(response.json())



    return response_default



def _build_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Response[ManifestRoot | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    body: Manifest,

) -> Response[ManifestRoot | Problem]:
    """  Validates, canonicalises and stores a manifest; returns its root hash for a later commit.

    Args:
        repo_id (UUID):
        body (Manifest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ManifestRoot | Problem]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
body=body,

    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)

def sync(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    body: Manifest,

) -> ManifestRoot | Problem | None:
    """  Validates, canonicalises and stores a manifest; returns its root hash for a later commit.

    Args:
        repo_id (UUID):
        body (Manifest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ManifestRoot | Problem
     """


    return sync_detailed(
        repo_id=repo_id,
client=client,
body=body,

    ).parsed

async def asyncio_detailed(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    body: Manifest,

) -> Response[ManifestRoot | Problem]:
    """  Validates, canonicalises and stores a manifest; returns its root hash for a later commit.

    Args:
        repo_id (UUID):
        body (Manifest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ManifestRoot | Problem]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
body=body,

    )

    response = await client.get_async_httpx_client().request(
        **kwargs
    )

    return _build_response(client=client, response=response)

async def asyncio(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    body: Manifest,

) -> ManifestRoot | Problem | None:
    """  Validates, canonicalises and stores a manifest; returns its root hash for a later commit.

    Args:
        repo_id (UUID):
        body (Manifest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ManifestRoot | Problem
     """


    return (await asyncio_detailed(
        repo_id=repo_id,
client=client,
body=body,

    )).parsed
