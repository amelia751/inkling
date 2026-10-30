from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.branch import Branch
from ...models.problem import Problem
from typing import cast
from uuid import UUID



def _get_kwargs(
    repo_id: UUID,
    *,
    name: str,
    expected_head: str,

) -> dict[str, Any]:
    

    

    params: dict[str, Any] = {}

    params["name"] = name

    params["expected_head"] = expected_head


    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}


    _kwargs: dict[str, Any] = {
        "method": "delete",
        "url": "/internal/v1/repos/{repo_id}/branches".format(repo_id=repo_id,),
        "params": params,
    }


    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Branch | Problem:
    if response.status_code == 200:
        response_200 = Branch.from_dict(response.json())



        return response_200

    response_default = Problem.from_dict(response.json())



    return response_default



def _build_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Response[Branch | Problem]:
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
    name: str,
    expected_head: str,

) -> Response[Branch | Problem]:
    """  Tombstones the branch; it stays a GC root for the retention period. Refused on protected branches.

    Args:
        repo_id (UUID):
        name (str):
        expected_head (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Branch | Problem]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
name=name,
expected_head=expected_head,

    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)

def sync(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    name: str,
    expected_head: str,

) -> Branch | Problem | None:
    """  Tombstones the branch; it stays a GC root for the retention period. Refused on protected branches.

    Args:
        repo_id (UUID):
        name (str):
        expected_head (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Branch | Problem
     """


    return sync_detailed(
        repo_id=repo_id,
client=client,
name=name,
expected_head=expected_head,

    ).parsed

async def asyncio_detailed(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    name: str,
    expected_head: str,

) -> Response[Branch | Problem]:
    """  Tombstones the branch; it stays a GC root for the retention period. Refused on protected branches.

    Args:
        repo_id (UUID):
        name (str):
        expected_head (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Branch | Problem]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
name=name,
expected_head=expected_head,

    )

    response = await client.get_async_httpx_client().request(
        **kwargs
    )

    return _build_response(client=client, response=response)

async def asyncio(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    name: str,
    expected_head: str,

) -> Branch | Problem | None:
    """  Tombstones the branch; it stays a GC root for the retention period. Refused on protected branches.

    Args:
        repo_id (UUID):
        name (str):
        expected_head (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Branch | Problem
     """


    return (await asyncio_detailed(
        repo_id=repo_id,
client=client,
name=name,
expected_head=expected_head,

    )).parsed
