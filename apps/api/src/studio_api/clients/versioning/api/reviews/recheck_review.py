from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.problem import Problem
from ...models.review import Review
from typing import cast
from uuid import UUID



def _get_kwargs(
    repo_id: UUID,
    review_id: UUID,

) -> dict[str, Any]:
    

    

    

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/internal/v1/repos/{repo_id}/reviews/{review_id}/recheck".format(repo_id=repo_id,review_id=review_id,),
    }


    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Problem | Review:
    if response.status_code == 200:
        response_200 = Review.from_dict(response.json())



        return response_200

    response_default = Problem.from_dict(response.json())



    return response_default



def _build_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Response[Problem | Review]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    repo_id: UUID,
    review_id: UUID,
    *,
    client: AuthenticatedClient | Client,

) -> Response[Problem | Review]:
    """ 
    Args:
        repo_id (UUID):
        review_id (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | Review]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
review_id=review_id,

    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)

def sync(
    repo_id: UUID,
    review_id: UUID,
    *,
    client: AuthenticatedClient | Client,

) -> Problem | Review | None:
    """ 
    Args:
        repo_id (UUID):
        review_id (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | Review
     """


    return sync_detailed(
        repo_id=repo_id,
review_id=review_id,
client=client,

    ).parsed

async def asyncio_detailed(
    repo_id: UUID,
    review_id: UUID,
    *,
    client: AuthenticatedClient | Client,

) -> Response[Problem | Review]:
    """ 
    Args:
        repo_id (UUID):
        review_id (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | Review]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
review_id=review_id,

    )

    response = await client.get_async_httpx_client().request(
        **kwargs
    )

    return _build_response(client=client, response=response)

async def asyncio(
    repo_id: UUID,
    review_id: UUID,
    *,
    client: AuthenticatedClient | Client,

) -> Problem | Review | None:
    """ 
    Args:
        repo_id (UUID):
        review_id (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | Review
     """


    return (await asyncio_detailed(
        repo_id=repo_id,
review_id=review_id,
client=client,

    )).parsed
