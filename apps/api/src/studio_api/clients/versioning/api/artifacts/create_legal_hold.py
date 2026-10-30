from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.legal_hold import LegalHold
from ...models.legal_hold_request import LegalHoldRequest
from ...models.problem import Problem
from typing import cast
from uuid import UUID



def _get_kwargs(
    repo_id: UUID,
    *,
    body: LegalHoldRequest,

) -> dict[str, Any]:
    headers: dict[str, Any] = {}


    

    

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/internal/v1/repos/{repo_id}/legal-holds".format(repo_id=repo_id,),
    }

    _kwargs["json"] = body.to_dict()


    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> LegalHold | Problem:
    if response.status_code == 201:
        response_201 = LegalHold.from_dict(response.json())



        return response_201

    response_default = Problem.from_dict(response.json())



    return response_default



def _build_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Response[LegalHold | Problem]:
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
    body: LegalHoldRequest,

) -> Response[LegalHold | Problem]:
    """ 
    Args:
        repo_id (UUID):
        body (LegalHoldRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[LegalHold | Problem]
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
    body: LegalHoldRequest,

) -> LegalHold | Problem | None:
    """ 
    Args:
        repo_id (UUID):
        body (LegalHoldRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        LegalHold | Problem
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
    body: LegalHoldRequest,

) -> Response[LegalHold | Problem]:
    """ 
    Args:
        repo_id (UUID):
        body (LegalHoldRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[LegalHold | Problem]
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
    body: LegalHoldRequest,

) -> LegalHold | Problem | None:
    """ 
    Args:
        repo_id (UUID):
        body (LegalHoldRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        LegalHold | Problem
     """


    return (await asyncio_detailed(
        repo_id=repo_id,
client=client,
body=body,

    )).parsed
