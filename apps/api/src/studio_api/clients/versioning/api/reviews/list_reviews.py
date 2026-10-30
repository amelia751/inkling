from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.problem import Problem
from ...models.review_page import ReviewPage
from ...models.review_status import ReviewStatus
from ...types import UNSET, Unset
from typing import cast
from uuid import UUID



def _get_kwargs(
    repo_id: UUID,
    *,
    status: ReviewStatus | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 100,

) -> dict[str, Any]:
    

    

    params: dict[str, Any] = {}

    json_status: str | Unset = UNSET
    if not isinstance(status, Unset):
        json_status = status.value

    params["status"] = json_status

    params["cursor"] = cursor

    params["limit"] = limit


    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}


    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/internal/v1/repos/{repo_id}/reviews".format(repo_id=repo_id,),
        "params": params,
    }


    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Problem | ReviewPage:
    if response.status_code == 200:
        response_200 = ReviewPage.from_dict(response.json())



        return response_200

    response_default = Problem.from_dict(response.json())



    return response_default



def _build_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Response[Problem | ReviewPage]:
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
    status: ReviewStatus | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 100,

) -> Response[Problem | ReviewPage]:
    """ 
    Args:
        repo_id (UUID):
        status (ReviewStatus | Unset):
        cursor (str | Unset):
        limit (int | Unset):  Default: 100.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | ReviewPage]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
status=status,
cursor=cursor,
limit=limit,

    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)

def sync(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    status: ReviewStatus | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 100,

) -> Problem | ReviewPage | None:
    """ 
    Args:
        repo_id (UUID):
        status (ReviewStatus | Unset):
        cursor (str | Unset):
        limit (int | Unset):  Default: 100.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | ReviewPage
     """


    return sync_detailed(
        repo_id=repo_id,
client=client,
status=status,
cursor=cursor,
limit=limit,

    ).parsed

async def asyncio_detailed(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    status: ReviewStatus | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 100,

) -> Response[Problem | ReviewPage]:
    """ 
    Args:
        repo_id (UUID):
        status (ReviewStatus | Unset):
        cursor (str | Unset):
        limit (int | Unset):  Default: 100.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | ReviewPage]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
status=status,
cursor=cursor,
limit=limit,

    )

    response = await client.get_async_httpx_client().request(
        **kwargs
    )

    return _build_response(client=client, response=response)

async def asyncio(
    repo_id: UUID,
    *,
    client: AuthenticatedClient | Client,
    status: ReviewStatus | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 100,

) -> Problem | ReviewPage | None:
    """ 
    Args:
        repo_id (UUID):
        status (ReviewStatus | Unset):
        cursor (str | Unset):
        limit (int | Unset):  Default: 100.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | ReviewPage
     """


    return (await asyncio_detailed(
        repo_id=repo_id,
client=client,
status=status,
cursor=cursor,
limit=limit,

    )).parsed
