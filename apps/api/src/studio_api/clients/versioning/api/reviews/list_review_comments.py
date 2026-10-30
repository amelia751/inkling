from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.comment import Comment
from ...models.problem import Problem
from typing import cast
from uuid import UUID



def _get_kwargs(
    repo_id: UUID,
    review_id: UUID,

) -> dict[str, Any]:
    

    

    

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/internal/v1/repos/{repo_id}/reviews/{review_id}/comments".format(repo_id=repo_id,review_id=review_id,),
    }


    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Problem | list[Comment]:
    if response.status_code == 200:
        response_200 = []
        _response_200 = response.json()
        for response_200_item_data in (_response_200):
            response_200_item = Comment.from_dict(response_200_item_data)



            response_200.append(response_200_item)

        return response_200

    response_default = Problem.from_dict(response.json())



    return response_default



def _build_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Response[Problem | list[Comment]]:
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

) -> Response[Problem | list[Comment]]:
    """ 
    Args:
        repo_id (UUID):
        review_id (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | list[Comment]]
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

) -> Problem | list[Comment] | None:
    """ 
    Args:
        repo_id (UUID):
        review_id (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | list[Comment]
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

) -> Response[Problem | list[Comment]]:
    """ 
    Args:
        repo_id (UUID):
        review_id (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | list[Comment]]
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

) -> Problem | list[Comment] | None:
    """ 
    Args:
        repo_id (UUID):
        review_id (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | list[Comment]
     """


    return (await asyncio_detailed(
        repo_id=repo_id,
review_id=review_id,
client=client,

    )).parsed
