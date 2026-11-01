from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.problem import Problem
from ...models.studio import Studio
from typing import cast
from uuid import UUID



def _get_kwargs(
    repo_id: UUID,
    *,
    ref: str,

) -> dict[str, Any]:
    

    

    params: dict[str, Any] = {}

    params["ref"] = ref


    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}


    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/internal/v1/repos/{repo_id}/studio".format(repo_id=repo_id,),
        "params": params,
    }


    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Problem | Studio:
    if response.status_code == 200:
        response_200 = Studio.from_dict(response.json())



        return response_200

    response_default = Problem.from_dict(response.json())



    return response_default



def _build_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Response[Problem | Studio]:
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
    ref: str,

) -> Response[Problem | Studio]:
    """  The Studio definition (`.studio/` files) at a branch, commit oid or release (todo10 §3.2).

    Args:
        repo_id (UUID):
        ref (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | Studio]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
ref=ref,

    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)

def sync(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    ref: str,

) -> Problem | Studio | None:
    """  The Studio definition (`.studio/` files) at a branch, commit oid or release (todo10 §3.2).

    Args:
        repo_id (UUID):
        ref (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | Studio
     """


    return sync_detailed(
        repo_id=repo_id,
client=client,
ref=ref,

    ).parsed

async def asyncio_detailed(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    ref: str,

) -> Response[Problem | Studio]:
    """  The Studio definition (`.studio/` files) at a branch, commit oid or release (todo10 §3.2).

    Args:
        repo_id (UUID):
        ref (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | Studio]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
ref=ref,

    )

    response = await client.get_async_httpx_client().request(
        **kwargs
    )

    return _build_response(client=client, response=response)

async def asyncio(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    ref: str,

) -> Problem | Studio | None:
    """  The Studio definition (`.studio/` files) at a branch, commit oid or release (todo10 §3.2).

    Args:
        repo_id (UUID):
        ref (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | Studio
     """


    return (await asyncio_detailed(
        repo_id=repo_id,
client=client,
ref=ref,

    )).parsed
