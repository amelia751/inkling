from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.commit import Commit
from ...models.problem import Problem
from typing import cast
from uuid import UUID



def _get_kwargs(
    repo_id: UUID,
    commit_oid: str,

) -> dict[str, Any]:
    

    

    

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/internal/v1/repos/{repo_id}/commits/{commit_oid}".format(repo_id=repo_id,commit_oid=commit_oid,),
    }


    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Commit | Problem:
    if response.status_code == 200:
        response_200 = Commit.from_dict(response.json())



        return response_200

    response_default = Problem.from_dict(response.json())



    return response_default



def _build_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Response[Commit | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    repo_id: UUID,
    commit_oid: str,
    *,
    client: AuthenticatedClient | Client,

) -> Response[Commit | Problem]:
    """ 
    Args:
        repo_id (UUID):
        commit_oid (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Commit | Problem]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
commit_oid=commit_oid,

    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)

def sync(
    repo_id: UUID,
    commit_oid: str,
    *,
    client: AuthenticatedClient | Client,

) -> Commit | Problem | None:
    """ 
    Args:
        repo_id (UUID):
        commit_oid (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Commit | Problem
     """


    return sync_detailed(
        repo_id=repo_id,
commit_oid=commit_oid,
client=client,

    ).parsed

async def asyncio_detailed(
    repo_id: UUID,
    commit_oid: str,
    *,
    client: AuthenticatedClient | Client,

) -> Response[Commit | Problem]:
    """ 
    Args:
        repo_id (UUID):
        commit_oid (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Commit | Problem]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
commit_oid=commit_oid,

    )

    response = await client.get_async_httpx_client().request(
        **kwargs
    )

    return _build_response(client=client, response=response)

async def asyncio(
    repo_id: UUID,
    commit_oid: str,
    *,
    client: AuthenticatedClient | Client,

) -> Commit | Problem | None:
    """ 
    Args:
        repo_id (UUID):
        commit_oid (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Commit | Problem
     """


    return (await asyncio_detailed(
        repo_id=repo_id,
commit_oid=commit_oid,
client=client,

    )).parsed
