from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.commit_result import CommitResult
from ...models.problem import Problem
from ...models.revert_request import RevertRequest
from typing import cast
from uuid import UUID



def _get_kwargs(
    repo_id: UUID,
    *,
    body: RevertRequest,

) -> dict[str, Any]:
    headers: dict[str, Any] = {}


    

    

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/internal/v1/repos/{repo_id}/reverts".format(repo_id=repo_id,),
    }

    _kwargs["json"] = body.to_dict()


    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> CommitResult | Problem:
    if response.status_code == 201:
        response_201 = CommitResult.from_dict(response.json())



        return response_201

    response_default = Problem.from_dict(response.json())



    return response_default



def _build_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Response[CommitResult | Problem]:
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
    body: RevertRequest,

) -> Response[CommitResult | Problem]:
    """  Creates a new commit whose manifest equals the target commit's manifest (spec §6).

    Args:
        repo_id (UUID):
        body (RevertRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CommitResult | Problem]
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
    body: RevertRequest,

) -> CommitResult | Problem | None:
    """  Creates a new commit whose manifest equals the target commit's manifest (spec §6).

    Args:
        repo_id (UUID):
        body (RevertRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CommitResult | Problem
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
    body: RevertRequest,

) -> Response[CommitResult | Problem]:
    """  Creates a new commit whose manifest equals the target commit's manifest (spec §6).

    Args:
        repo_id (UUID):
        body (RevertRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CommitResult | Problem]
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
    body: RevertRequest,

) -> CommitResult | Problem | None:
    """  Creates a new commit whose manifest equals the target commit's manifest (spec §6).

    Args:
        repo_id (UUID):
        body (RevertRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CommitResult | Problem
     """


    return (await asyncio_detailed(
        repo_id=repo_id,
client=client,
body=body,

    )).parsed
